// Simulated CRM APIs and a fake SMTP server. Each CRM mock answers the endpoints the adapter
// calls, in the shapes the vendor documents, and keeps what it receives in memory so a test can
// check what landed where. They prove the relay's logic and the request shapes we wrote; they do
// not prove the vendor accepts them, which only a run against a real account can.
import http from 'node:http';
import net from 'node:net';

export async function startCrmMock() {
  const db = { hubspot: { contacts: [], notes: [] }, pipedrive: { persons: [], orgs: [], leads: [], notes: [] }, salesforce: { leads: [], tasks: [], tokens: 0 }, attio: { people: [], notes: [] }, frappe: {}, webhook: [] };
  const calls = [];
  const failures = []; // { match: RegExp, status, times }
  let seq = 100;

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    calls.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), headers: req.headers, raw });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const f = failures.find((x) => x.times > 0 && x.match.test(`${req.method} ${p}`));
    if (f) { f.times--; return send(f.status, { message: 'injected failure' }); }
    let body = {};
    try { body = raw ? (req.headers['content-type']?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : {}; } catch {}

    // ---- HubSpot
    if (p.startsWith('/hubspot')) {
      if (req.headers.authorization !== 'Bearer hs-token') return send(401, { message: 'bad token' });
      const h = db.hubspot;
      if (p === '/hubspot/crm/v3/objects/contacts/search') {
        const email = body.filterGroups[0].filters[0].value;
        const c = h.contacts.find((x) => x.properties.email === email);
        return send(200, { total: c ? 1 : 0, results: c ? [c] : [] });
      }
      if (p === '/hubspot/crm/v3/objects/contacts' && req.method === 'POST') {
        const c = { id: String(seq++), properties: body.properties };
        h.contacts.push(c);
        return send(201, c);
      }
      const m = p.match(/^\/hubspot\/crm\/v3\/objects\/contacts\/(\d+)$/);
      if (m && req.method === 'PATCH') {
        const c = h.contacts.find((x) => x.id === m[1]);
        Object.assign(c.properties, body.properties);
        return send(200, c);
      }
      if (p === '/hubspot/crm/v3/objects/notes') {
        const n = { id: String(seq++), ...body };
        h.notes.push(n);
        return send(201, n);
      }
    }

    // ---- Pipedrive
    if (p.startsWith('/pipedrive')) {
      if (req.headers['x-api-token'] !== 'pd-token') return send(401, { success: false });
      const d = db.pipedrive;
      if (p === '/pipedrive/v1/persons/search') {
        const hit = d.persons.find((x) => x.email.some((e) => e.value === url.searchParams.get('term')));
        return send(200, { success: true, data: { items: hit ? [{ result_score: 1, item: { id: hit.id, name: hit.name, organization: hit.org_id ? { id: hit.org_id } : null } }] : [] } });
      }
      if (p === '/pipedrive/v1/organizations/search') {
        const hit = d.orgs.find((x) => x.name === url.searchParams.get('term'));
        return send(200, { success: true, data: { items: hit ? [{ item: { id: hit.id, name: hit.name } }] : [] } });
      }
      if (p === '/pipedrive/v1/organizations') { const o = { id: seq++, ...body }; d.orgs.push(o); return send(201, { success: true, data: o }); }
      if (p === '/pipedrive/v1/persons') { const o = { id: seq++, ...body }; d.persons.push(o); return send(201, { success: true, data: o }); }
      const m = p.match(/^\/pipedrive\/v1\/persons\/(\d+)$/);
      if (m && req.method === 'PUT') { const o = d.persons.find((x) => x.id === Number(m[1])); Object.assign(o, body); return send(200, { success: true, data: o }); }
      if (p === '/pipedrive/v1/leads') { const o = { id: `lead-${seq++}`, ...body }; d.leads.push(o); return send(201, { success: true, data: o }); }
      if (p === '/pipedrive/v1/notes') { const o = { id: seq++, ...body }; d.notes.push(o); return send(201, { success: true, data: o }); }
    }

    // ---- Salesforce
    if (p.startsWith('/salesforce')) {
      const d = db.salesforce;
      if (p === '/salesforce/services/oauth2/token') {
        if (body.client_id !== 'sf-id' || body.client_secret !== 'sf-secret' || body.grant_type !== 'client_credentials') return send(400, { error: 'invalid_client' });
        d.tokens++;
        return send(200, { access_token: 'sf-access', instance_url: `http://127.0.0.1:${server.address().port}/salesforce`, token_type: 'Bearer' });
      }
      if (req.headers.authorization !== 'Bearer sf-access') return send(401, [{ errorCode: 'INVALID_SESSION_ID' }]);
      if (p === '/salesforce/services/data/v61.0/query') {
        const email = url.searchParams.get('q').match(/Email = '((?:[^'\\]|\\.)*)'/)[1].replace(/\\(.)/g, '$1');
        const hit = d.leads.find((x) => x.Email === email);
        return send(200, { totalSize: hit ? 1 : 0, records: hit ? [hit] : [] });
      }
      if (p === '/salesforce/services/data/v61.0/sobjects/Lead') {
        if (!body.LastName || !body.Company) return send(400, [{ errorCode: 'REQUIRED_FIELD_MISSING' }]);
        const o = { Id: `00Q${seq++}`, ...body }; d.leads.push(o); return send(201, { id: o.Id, success: true });
      }
      const m = p.match(/^\/salesforce\/services\/data\/v61\.0\/sobjects\/Lead\/(\w+)$/);
      if (m && req.method === 'PATCH') { Object.assign(d.leads.find((x) => x.Id === m[1]), body); res.writeHead(204); return res.end(); }
      if (p === '/salesforce/services/data/v61.0/sobjects/Task') { const o = { Id: `00T${seq++}`, ...body }; d.tasks.push(o); return send(201, { id: o.Id, success: true }); }
    }

    // ---- Attio
    if (p.startsWith('/attio')) {
      if (req.headers.authorization !== 'Bearer at-token') return send(401, {});
      const d = db.attio;
      if (p === '/attio/v2/objects/people/records/query') {
        const hit = d.people.find((x) => x.values.email_addresses.includes(body.filter.email_addresses));
        return send(200, { data: hit ? [{ id: { record_id: hit.id }, values: Object.fromEntries(Object.entries(hit.values).map(([k, v]) => [k, Array.isArray(v) ? v : [v]])) }] : [] });
      }
      if (p === '/attio/v2/objects/people/records' && req.method === 'POST') { const o = { id: `rec-${seq++}`, values: body.data.values }; d.people.push(o); return send(200, { data: { id: { record_id: o.id } } }); }
      const m = p.match(/^\/attio\/v2\/objects\/people\/records\/([\w-]+)$/);
      if (m && req.method === 'PATCH') { Object.assign(d.people.find((x) => x.id === m[1]).values, body.data.values); return send(200, { data: { id: { record_id: m[1] } } }); }
      if (p === '/attio/v2/notes') { const o = { id: `note-${seq++}`, ...body.data }; d.notes.push(o); return send(200, { data: { id: { note_id: o.id } } }); }
    }

    // ---- Frappe /api/resource
    if (p.startsWith('/frappe/api/resource/')) {
      if (req.headers.authorization !== 'token fk:fs') return send(401, { exc_type: 'AuthenticationError' });
      const [doctype, name] = p.slice('/frappe/api/resource/'.length).split('/').map(decodeURIComponent);
      const rows = (db.frappe[doctype] ||= []);
      if (req.method === 'GET') {
        const [[field, , value]] = JSON.parse(url.searchParams.get('filters'));
        return send(200, { data: rows.filter((r) => r[field] === value).slice(0, 1) });
      }
      if (req.method === 'POST') { const o = { name: `${doctype}-${seq++}`, ...body }; rows.push(o); return send(200, { data: o }); }
      if (req.method === 'PUT') { const o = rows.find((r) => r.name === name); Object.assign(o, body); return send(200, { data: o }); }
    }

    // ---- Webhook
    if (p === '/hook') { db.webhook.push({ headers: req.headers, raw }); return send(200, { id: `hook-${seq++}` }); }

    send(404, { message: `mock: no route for ${req.method} ${p}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, db, calls, fail: (match, status, times = 1) => failures.push({ match, status, times }), close: () => new Promise((r) => server.close(r)) };
}

// Speaks enough SMTP for the client: greeting, EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT
export async function startSmtpMock({ user = 'u', pass = 'p' } = {}) {
  const messages = [];
  const failData = { code: 0, times: 0 };
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let msg = null;
    const say = (l) => sock.write(l + '\r\n');
    say('220 mock ESMTP');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            if (failData.times > 0) { failData.times--; say(`${failData.code} injected failure`); } else { messages.push(msg); say('250 queued'); }
          } else msg.data.push(line);
          continue;
        }
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') { sock.write('250-mock\r\n250 AUTH PLAIN\r\n'); } else if (cmd === 'AUTH') {
          const [, u, p] = Buffer.from(line.split(' ')[2], 'base64').toString().split('\0');
          say(u === user && p === pass ? '235 ok' : '535 bad credentials');
        } else if (cmd === 'MAIL') { msg = { from: line, rcpt: [], data: [] }; say('250 ok'); } else if (cmd === 'RCPT') { msg.rcpt.push(line); say('250 ok'); } else if (cmd === 'DATA') { inData = true; say('354 go'); } else if (cmd === 'QUIT') { say('221 bye'); sock.end(); } else say('500 what');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, messages, failData: (code, times = 1) => Object.assign(failData, { code, times }), close: () => new Promise((r) => server.close(r)) };
}

// Decodes the base64 text body of a captured message
export function bodyOf(m) {
  const i = m.data.indexOf('');
  return { headers: m.data.slice(0, i), text: Buffer.from(m.data.slice(i + 1).join(''), 'base64').toString('utf8').replace(/\r\n/g, '\n') };
}
