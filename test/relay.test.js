import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmMock, startSmtpMock, bodyOf } from './mocks.js';
import { startNode } from '../src/runtime/node.js';
import { validate } from '../src/config.js';
import { sign } from '../src/crm/webhook.js';
import { normalize } from '../src/lead.js';

const ORIGIN = 'https://site.example';
let crm, smtp, node, dir, clock;

function config(over = {}) {
  return validate({
    salt: 's', adminToken: 'admin-token', maxAttempts: 3, rateLimitPerHour: 50,
    forms: {
      contact: { title: 'Contact form', allowedOrigins: [ORIGIN], required: ['email', 'first_name'], crm: ['hubspot'], notify: 'team', successUrl: `${ORIGIN}/thanks` },
      all: { title: 'Demo request', allowedOrigins: [ORIGIN], crm: ['hubspot', 'pipedrive', 'salesforce', 'attio', 'dandirock', 'hook'], notify: 'team' },
      consent: { title: 'Newsletter', allowedOrigins: [ORIGIN], consent: { required: true, text: 'Send me the newsletter' }, crm: ['dandirock'] },
      ...over.forms,
    },
    crms: {
      hubspot: { type: 'hubspot', token: 'hs-token', baseUrl: `${crm.base}/hubspot` },
      pipedrive: { type: 'pipedrive', token: 'pd-token', baseUrl: `${crm.base}/pipedrive` },
      salesforce: { type: 'salesforce', instanceUrl: `${crm.base}/salesforce`, clientId: 'sf-id', clientSecret: 'sf-secret' },
      attio: { type: 'attio', token: 'at-token', baseUrl: `${crm.base}/attio` },
      dandirock: { type: 'dandirock', baseUrl: `${crm.base}/frappe`, apiKey: 'fk', apiSecret: 'fs' },
      hook: { type: 'webhook', url: `${crm.base}/hook`, secret: 'whsec' },
    },
    notify: { team: { transport: 'smtp', to: ['team@site.example'], from: 'forms@site.example', fromName: 'Website', smtp: { host: '127.0.0.1', port: smtp.port, tls: 'off', user: 'u', pass: 'p' } } },
  }, {});
}

async function post(form, body, { origin = ORIGIN, json = true, headers = {} } = {}) {
  const res = await fetch(`${node.url}/f/${form}`, {
    method: 'POST', redirect: 'manual',
    headers: { origin, 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded', ...headers },
    body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, location: res.headers.get('location') };
}

before(async () => {
  crm = await startCrmMock();
  smtp = await startSmtpMock();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-connector-'));
  clock = Date.now();
  node = await startNode({ config: config(), dbPath: path.join(dir, 'test.db'), port: 0, retryEveryMs: 0, runtime: { log: () => {}, now: () => clock } });
});

after(async () => {
  await node.close();
  await crm.close();
  await smtp.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a submission lands in HubSpot with a note, then the team gets an email saying so', async () => {
  const r = await post('contact', { _id: 'aaaaaaaa-0001', name: 'Ada Lovelace', email: 'Ada@Example.com', company: 'Analytical Engines', role: 'CTO', message: 'We need a demo.\nNext week works.', page_url: `${ORIGIN}/pricing` });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  await node.settle();

  const c = crm.db.hubspot.contacts.find((x) => x.properties.email === 'ada@example.com');
  assert.ok(c, 'contact created with a lowercased email');
  assert.deepEqual(
    { f: c.properties.firstname, l: c.properties.lastname, co: c.properties.company, t: c.properties.jobtitle, ls: c.properties.lifecyclestage },
    { f: 'Ada', l: 'Lovelace', co: 'Analytical Engines', t: 'CTO', ls: 'lead' });
  const note = crm.db.hubspot.notes.at(-1);
  assert.equal(note.associations[0].to.id, c.id);
  assert.match(note.properties.hs_note_body, /Filled in &quot;Contact form&quot; on site.example/);
  assert.match(note.properties.hs_note_body, /We need a demo/);

  const mail = smtp.messages.at(-1);
  const { headers, text } = bodyOf(mail);
  assert.ok(headers.includes('Reply-To: <ada@example.com>'));
  assert.ok(headers.some((h) => h.startsWith('Subject: New Contact form from Ada Lovelace')));
  assert.match(text, /hubspot: created, contact \d+/);
  assert.match(text, /Message:\nWe need a demo\.\nNext week works\./);
});

test('the same submission sent twice (double click, lost response) creates nothing new', async () => {
  const notes = crm.db.hubspot.notes.length;
  const mails = smtp.messages.length;
  const r = await post('contact', { _id: 'aaaaaaaa-0001', name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.equal(r.data.duplicate, true);
  await node.settle();
  assert.equal(crm.db.hubspot.notes.length, notes);
  assert.equal(smtp.messages.length, mails);
});

test('a returning visitor fills empty fields only and gets a second note', async () => {
  const r = await post('contact', { _id: 'aaaaaaaa-0002', first_name: 'Augusta', email: 'ada@example.com', phone: '+41 44 000 00 00' });
  assert.equal(r.status, 200);
  await node.settle();
  const contacts = crm.db.hubspot.contacts.filter((x) => x.properties.email === 'ada@example.com');
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].properties.firstname, 'Ada', 'an existing first name is never overwritten');
  assert.equal(contacts[0].properties.phone, '+41 44 000 00 00', 'an empty phone is filled');
  assert.equal(crm.db.hubspot.notes.filter((n) => n.associations[0].to.id === contacts[0].id).length, 2);
  assert.match(bodyOf(smtp.messages.at(-1)).text, /hubspot: updated/);
});

test('one form can feed every adapter at once', async () => {
  const r = await post('all', { _id: 'bbbbbbbb-0001', first_name: 'Grace', last_name: 'Hopper', email: "grace.o'hopper@navy.example", company: 'Navy', job_title: 'Rear Admiral', phone: '+1 555 0100', message: 'Compilers.' });
  assert.equal(r.status, 200);
  await node.settle();
  const email = "grace.o'hopper@navy.example";

  const pd = crm.db.pipedrive;
  const person = pd.persons.find((p) => p.email[0].value === email);
  assert.equal(person.name, 'Grace Hopper');
  assert.equal(person.org_id, pd.orgs.find((o) => o.name === 'Navy').id);
  assert.equal(pd.leads.at(-1).person_id, person.id);
  assert.equal(pd.notes.at(-1).lead_id, pd.leads.at(-1).id);
  assert.ok(crm.calls.filter((c) => c.path.startsWith('/pipedrive')).every((c) => !c.query.api_token), 'the token never rides in the URL');

  const sf = crm.db.salesforce;
  const lead = sf.leads.find((l) => l.Email === email);
  assert.deepEqual({ ln: lead.LastName, co: lead.Company, src: lead.LeadSource }, { ln: 'Hopper', co: 'Navy', src: 'Web' });
  assert.equal(sf.tasks.at(-1).WhoId, lead.Id);
  assert.ok(crm.calls.some((c) => c.path.endsWith('/query') && c.query.q.includes("grace.o\\'hopper")), 'the quote is escaped in SOQL');

  const at = crm.db.attio;
  const person2 = at.people.find((p) => p.values.email_addresses.includes(email));
  assert.equal(person2.values.name[0].full_name, 'Grace Hopper');
  assert.equal(at.notes.at(-1).parent_record_id, person2.id);

  const dr = crm.db.frappe['DR Lead'].find((l) => l.email === email);
  assert.deepEqual({ fn: dr.first_name, org: dr.organization, src: dr.source, type: dr.lead_type, list: dr.lead_list, cons: dr.marketing_consent },
    { fn: 'Grace', org: 'Navy', src: 'Website form', type: 'Inbound request', list: 'Website', cons: 0 });
  const drNote = crm.db.frappe['DR Note'].at(-1);
  assert.deepEqual({ d: drNote.reference_doctype, n: drNote.reference_name, k: drNote.kind }, { d: 'DR Lead', n: dr.name, k: 'Note' });
  assert.match(drNote.content, /Compilers\./);

  const hook = crm.db.webhook.at(-1);
  const expected = await sign('whsec', hook.headers['x-relay-timestamp'], hook.raw);
  assert.equal(hook.headers['x-relay-signature'], expected, 'the receiver can verify the signature on the exact bytes');
  assert.equal(JSON.parse(hook.raw).lead.email, email);

  const { text } = bodyOf(smtp.messages.at(-1));
  for (const n of ['hubspot', 'pipedrive', 'salesforce', 'attio', 'dandirock', 'hook']) assert.match(text, new RegExp(`${n}: created|${n}: sent`));
});

test('a CRM outage is retried without duplicating the record or the note', async () => {
  crm.fail(/POST \/hubspot\/crm\/v3\/objects\/notes/, 503, 1);
  await post('contact', { _id: 'cccccccc-0001', first_name: 'Katherine', email: 'kj@nasa.example' });
  await node.settle();
  assert.match(bodyOf(smtp.messages.at(-1)).text, /hubspot: not yet, will retry/);
  const before = crm.db.hubspot.contacts.filter((c) => c.properties.email === 'kj@nasa.example').length;
  assert.equal(before, 1, 'the contact was created before the note failed');

  clock += 61_000; // past the first backoff of one minute
  const r = await node.relay.runDue();
  assert.equal(r.tried, 1);
  const c = crm.db.hubspot.contacts.filter((x) => x.properties.email === 'kj@nasa.example');
  assert.equal(c.length, 1, 'the retry resumed at the note instead of creating a second contact');
  assert.equal(crm.db.hubspot.notes.filter((n) => n.associations[0].to.id === c[0].id).length, 1);
});

test('data the CRM rejects (400) is not retried, and a person is told', async () => {
  const before = smtp.messages.length;
  crm.fail(/POST \/hubspot\/crm\/v3\/objects\/contacts$/, 400, 1);
  await post('contact', { _id: 'dddddddd-0001', first_name: 'Rejected', email: 'bad@data.example' });
  await node.settle();
  const status = await (await fetch(`${node.url}/admin/status`, { headers: { authorization: 'Bearer admin-token' } })).json();
  const sub = status.recent.find((s) => s.email === 'bad@data.example');
  assert.equal(sub.deliveries.find((d) => d.target === 'crm:hubspot').status, 'dead');
  assert.equal(sub.deliveries.find((d) => d.target === 'notify').status, 'done');
  assert.match(bodyOf(smtp.messages.at(-1)).text, /rejected by the CRM and needs a person/);
  assert.equal(smtp.messages.length, before + 1);
});

test('a failing mail server is retried, and the CRM push is not repeated', async () => {
  smtp.failData(451, 1); // a temporary refusal, the kind a busy mail server gives
  const mails = smtp.messages.length;
  await post('contact', { _id: 'gggggggg-0001', first_name: 'Mary', email: 'mary@site.example' });
  await node.settle();
  assert.equal(smtp.messages.length, mails, 'nothing delivered yet');
  const calls = crm.calls.length;
  clock += 61_000;
  await node.relay.runDue();
  assert.equal(smtp.messages.length, mails + 1);
  assert.match(bodyOf(smtp.messages.at(-1)).text, /hubspot: created/);
  assert.equal(crm.calls.length, calls, 'the CRM was not called again');
});

test('bots, foreign origins, missing fields and missing consent are refused before anything is stored', async () => {
  const contactsBefore = crm.db.hubspot.contacts.length;
  const bot = await post('contact', { first_name: 'Bot', email: 'bot@spam.example', _gotcha: 'http://spam' });
  assert.equal(bot.status, 200, 'a bot gets the same answer as a person');
  const fast = await post('contact', { first_name: 'Fast', email: 'fast@spam.example', _t: String(clock - 200) });
  assert.equal(fast.status, 200);
  const foreign = await post('contact', { first_name: 'X', email: 'x@evil.example' }, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const noName = await post('contact', { email: 'noname@site.example' });
  assert.deepEqual([noName.status, noName.data.fields], [422, ['first_name']]);
  const badEmail = await post('contact', { first_name: 'B', email: 'not-an-email' });
  assert.deepEqual([badEmail.status, badEmail.data.fields], [422, ['email']]);
  const noConsent = await post('consent', { email: 'nc@site.example' });
  assert.equal(noConsent.data.error, 'consent');
  await node.settle();
  assert.equal(crm.db.hubspot.contacts.length, contactsBefore);
  const status = await (await fetch(`${node.url}/admin/status`, { headers: { authorization: 'Bearer admin-token' } })).json();
  assert.ok(!status.recent.some((s) => /spam|evil|noname|not-an/.test(s.email)));
});

test('consent given on the form reaches the CRM with its wording', async () => {
  await post('consent', { _id: 'eeeeeeee-0001', email: 'yes@site.example', consent: 'on' });
  await node.settle();
  const dr = crm.db.frappe['DR Lead'].find((l) => l.email === 'yes@site.example');
  assert.equal(dr.marketing_consent, 1);
  assert.equal(dr.consent_wording, 'Send me the newsletter');
  assert.match(dr.consent_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dr.first_name, 'yes@site.example', 'the email stands in for a missing first name');
});

test('consent given later is added to an existing lead, and never removed', async () => {
  const email = "grace.o'hopper@navy.example"; // created without consent by the every-adapter test
  await post('consent', { _id: 'eeeeeeee-0002', email, consent: 'yes' });
  await node.settle();
  const dr = crm.db.frappe['DR Lead'].find((l) => l.email === email);
  assert.equal(dr.marketing_consent, 1);
  assert.equal(dr.consent_wording, 'Send me the newsletter');
  await post('all', { _id: 'eeeeeeee-0003', email, first_name: 'Grace' });
  await node.settle();
  assert.equal(crm.db.frappe['DR Lead'].find((l) => l.email === email).marketing_consent, 1);
});

test('a plain HTML form without JavaScript gets a redirect to the thank-you page', async () => {
  const r = await post('contact', { first_name: 'Plain', email: 'plain@site.example' }, { json: false });
  assert.equal(r.status, 303);
  assert.equal(r.location, `${ORIGIN}/thanks`);
  const evil = await post('contact', { first_name: 'Plain2', email: 'plain2@site.example', _redirect: 'https://evil.example/phish' }, { json: false });
  assert.equal(evil.location, `${ORIGIN}/thanks`, 'a redirect to another site is ignored');
  await node.settle();
});

test('a line break in a name cannot add an email header', async () => {
  await post('contact', { _id: 'ffffffff-0001', first_name: 'Eve\r\nBcc: victim@example.com', email: 'eve@site.example' });
  await node.settle();
  const { headers } = bodyOf(smtp.messages.at(-1));
  assert.ok(!headers.some((h) => /^Bcc:/i.test(h)));
});

test('the admin API needs its token', async () => {
  assert.equal((await fetch(`${node.url}/admin/status`)).status, 401);
  assert.equal((await fetch(`${node.url}/admin/status`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
});

test('submissions are deleted after the retention period', async () => {
  clock += 31 * 86400_000;
  const r = await node.relay.runDue();
  assert.ok(r.purged >= 5);
  const status = await (await fetch(`${node.url}/admin/status`, { headers: { authorization: 'Bearer admin-token' } })).json();
  assert.equal(status.recent.length, 0);
});

test('field aliases in several languages map to the same lead', () => {
  const lead = normalize({ Vorname: 'Jean', nom: 'Dupont', 'E-Mail': 'J@D.CH', firma: 'Dupont SA', Telefon: '+41', budget: '10k', _gotcha: '' }, { id: 'f' });
  assert.deepEqual({ fn: lead.first_name, ln: lead.last_name, e: lead.email, c: lead.company }, { fn: 'Jean', ln: 'Dupont', e: 'j@d.ch', c: 'Dupont SA' });
  assert.equal(lead.extra.budget, '10k');
  assert.equal(lead.extra.Telefon, '+41', 'an unknown field is kept, not dropped');
});

test('config errors are all reported at once', () => {
  assert.throws(() => validate({ forms: { a: { crm: ['nope'] } }, crms: { x: { type: 'hubspot' } }, notify: {} }, {}), (e) => {
    assert.ok(e.errors.length >= 3, e.message);
    return true;
  });
});
