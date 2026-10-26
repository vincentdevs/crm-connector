// The relay itself, written against Web standard Request and Response so the same code runs on
// Node and on Cloudflare Workers. A submission goes through four steps, all of them rules:
//   1. check   origin, size, honeypot, rate, required fields, email shape, consent
//   2. store   one outbox row per target, before anything leaves, so nothing can be lost
//   3. CRMs    each configured CRM in order: match on email, create or fill, add a note
//   4. email   the notification, which says where the lead landed in each CRM
// Steps 3 and 4 run after the visitor has their answer, and failures are retried with backoff.
import { normalize, isEmail, oneLine, fieldValue } from './lead.js';
import { resolveAdapter } from './crm/index.js';
import { compose, send } from './notify/index.js';
import { EMBED } from './embed.js';

const MAX_BODY = 32 * 1024;
const LEASE_MS = 2 * 60 * 1000;
const MIN_FILL_MS = 1500;

export function backoff(attempt) {
  return Math.min(60_000 * 2 ** (attempt - 1), 6 * 3600_000);
}

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createRelay({ config, store, runtime }) {
  const rt = { fetch: globalThis.fetch.bind(globalThis), log: console.log, now: Date.now, defer: (p) => p.catch(() => {}), ...runtime };
  const cache = rt.cache || {}; // per-process cache, e.g. a Salesforce access token
  const log = (msg) => rt.log(`[crm-connector] ${msg}`);

  // ---------------------------------------------------------------- HTTP

  async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/health') return json({ ok: true });
    if (path === '/embed.js') return new Response(EMBED, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' } });
    if (path.startsWith('/admin/')) return admin(request, path);
    const m = path.match(/^\/f\/([\w-]{1,64})$/);
    if (!m) return json({ ok: false, error: 'not_found' }, 404);
    const form = config.forms[m[1]];
    if (!form) return json({ ok: false, error: 'unknown_form' }, 404);

    const origin = request.headers.get('origin') || originOf(request.headers.get('referer'));
    const allowed = origin && form.allowedOrigins.includes(origin);
    const cors = allowed ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: allowed ? 204 : 403, headers: { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type, accept', 'access-control-max-age': '86400' } });
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405, cors);

    const ctype = request.headers.get('content-type') || '';
    const wantsJson = ctype.includes('json') || (request.headers.get('accept') || '').includes('application/json');
    const answer = (status, body) => (wantsJson ? json(body, status, cors) : page(form, status, body));

    if (!allowed) return answer(403, { ok: false, error: 'origin', message: 'This form cannot be sent from this website.' });
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return answer(413, { ok: false, error: 'too_large', message: 'The form is too large.' });

    let fields;
    try {
      fields = await readFields(request, ctype);
    } catch (e) {
      return answer(400, { ok: false, error: 'bad_body', message: 'The form could not be read.' });
    }
    const ip = request.headers.get('cf-connecting-ip') || rt.clientIp?.(request) || '';
    const result = await submit(form, fields, { ip, referer: request.headers.get('referer') || '' });
    if (!wantsJson && result.status === 200) {
      const target = safeRedirect(fields._redirect, form) || form.successUrl;
      if (target) return new Response(null, { status: 303, headers: { location: target } });
    }
    return answer(result.status, result.body);
  }

  async function readFields(request, ctype) {
    const raw = await request.text();
    if (raw.length > MAX_BODY) throw new Error('too large');
    let obj;
    if (ctype.includes('application/json')) obj = JSON.parse(raw || '{}');
    else if (ctype.includes('application/x-www-form-urlencoded')) obj = Object.fromEntries(new URLSearchParams(raw));
    else if (ctype.includes('multipart/form-data')) {
      const fd = await new Response(raw, { headers: { 'content-type': ctype } }).formData();
      obj = {};
      fd.forEach((v, k) => { if (typeof v === 'string') obj[k] = obj[k] ? `${obj[k]}, ${v}` : v; });
    } else throw new Error('unsupported content type');
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      out[String(k).slice(0, 80)] = Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return out;
  }

  // ---------------------------------------------------------------- 1 and 2: check, then store

  async function submit(form, fields, meta = {}) {
    const now = rt.now();
    const thanks = { ok: true, message: form.successMessage || 'Thank you, your message has been sent.' };

    // A bot that fills the hidden field, or posts faster than a person can type, gets the same
    // answer as a person, so it learns nothing, and nothing is stored or sent.
    const honeypot = form.honeypot || '_gotcha';
    const started = Number(fields._t || 0);
    if ((fields[honeypot] || '').trim() || (started && now - started < MIN_FILL_MS)) {
      log(`form ${form.id}: dropped a bot submission`);
      return { status: 200, body: { ...thanks, id: null } };
    }

    const lead = normalize(fields, form, { referer: meta.referer, now: new Date(now).toISOString() });
    const missing = [];
    if (!isEmail(lead.email)) missing.push('email');
    for (const r of form.required || []) if (r !== 'email' && !fieldValue(lead, r, form)) missing.push(r);
    if (missing.length) return { status: 422, body: { ok: false, error: 'missing', fields: missing, message: missing.includes('email') ? 'Please enter a valid email address.' : `Please fill in: ${missing.join(', ')}.` } };
    if (form.consent?.required && !lead.consent_marketing) {
      return { status: 422, body: { ok: false, error: 'consent', fields: [form.consent.field], message: form.consent.message || 'Please give your consent to continue.' } };
    }

    const ipHash = meta.ip ? await sha256(`${config.salt || 'crm-connector'}:${meta.ip}`) : null;
    if (ipHash && config.rateLimitPerHour) {
      const n = await store.countRecent(ipHash, now - 3600_000);
      if (n >= config.rateLimitPerHour) return { status: 429, body: { ok: false, error: 'rate', message: 'Too many submissions from this connection. Please try again later.' } };
    }

    const clientId = /^[\w-]{8,64}$/.test(fields._id || '') ? fields._id : null;
    const day = new Date(now).toISOString().slice(0, 10);
    const idem = clientId ? `${form.id}:${clientId}` : `${form.id}:${await sha256(JSON.stringify(Object.entries(fields).filter(([k]) => !k.startsWith('_')).sort()) + day)}`;
    const targets = [...(form.crm || []).map((c) => `crm:${c}`), ...(form.notify ? ['notify'] : [])];
    const id = rt.randomId ? rt.randomId() : crypto.randomUUID();
    const res = await store.insert({ id, form: form.id, idem, lead, ipHash, now, purgeAt: now + config.retentionDays * 86400_000, targets });
    if (res.duplicate) {
      log(`form ${form.id}: duplicate of ${res.id}, not sent again`);
      return { status: 200, body: { ...thanks, id: res.id, duplicate: true } };
    }
    log(`form ${form.id}: stored ${id} (${targets.join(', ') || 'no targets'})`);
    rt.defer(deliverSubmission(id));
    return { status: 200, body: { ...thanks, id } };
  }

  // ---------------------------------------------------------------- 3 and 4: deliver

  async function deliverSubmission(id) {
    const lead = await store.lead(id);
    if (!lead) return;
    const form = config.forms[lead.form];
    for (const t of (form?.crm || []).map((c) => `crm:${c}`)) await attempt(id, t, lead, form);
    if (form?.notify) await attempt(id, 'notify', lead, form);
  }

  async function attempt(id, target, lead, form) {
    const now = rt.now();
    const claim = await store.claim(id, target, now, LEASE_MS);
    if (!claim) return;
    const attempts = claim.attempts + 1;
    const state = claim.state;
    try {
      let result;
      if (target === 'notify') {
        const rows = (await store.deliveries(id)).filter((r) => r.target.startsWith('crm:'))
          .map((r) => ({ target: r.target.slice(4), status: r.status, ...(r.result || {}), error: r.error, permanent: r.status === 'dead' }));
        const n = config.notify[form.notify];
        const { subject, text } = compose(lead, n, rows, id);
        result = { via: await send(n, { subject, text, replyTo: lead.email, messageId: `${id}@crm-connector` }, rt) };
      } else {
        const name = target.slice(4);
        const { mod, opts } = resolveAdapter(config.crms[name]);
        const host = originOf(lead.page_url)?.replace(/^https?:\/\//, '');
        const ctx = {
          fetch: rt.fetch, state, cache, submissionId: id,
          noteTitle: `Filled in "${lead.form_title}"${host ? ` on ${host}` : ''}`,
          save: () => store.saveState(id, target, state, rt.now()),
        };
        result = await mod.deliver(lead, opts, ctx);
      }
      await store.finish(id, target, { status: 'done', attempts, nextAt: 0, state, result, now: rt.now() });
      log(`${id} ${target}: done${result.action ? ` (${result.action}, ${result.ref})` : ''}`);
    } catch (err) {
      const dead = err.permanent || attempts >= config.maxAttempts;
      const error = oneLine(err.message, 500);
      await store.finish(id, target, { status: dead ? 'dead' : 'failed', attempts, nextAt: dead ? 0 : rt.now() + backoff(attempts), state, error, now: rt.now() });
      log(`${id} ${target}: ${dead ? 'gave up' : `failed, retry in ${Math.round(backoff(attempts) / 60000)} min`}: ${error}`);
      // A delivery that will never succeed on its own is told to a person, unless the notification
      // has not gone out yet, since that email already carries the failure.
      if (dead && target !== 'notify' && form?.notify && attempts > 1) await alert(id, target, lead, form, error);
    }
  }

  async function alert(id, target, lead, form, error) {
    const n = config.notify[form.notify];
    try {
      await send(n, {
        subject: oneLine(`Lead not added to ${target.slice(4)}: ${lead.email}`),
        text: `The relay gave up adding this lead to ${target.slice(4)}.\n\nError: ${error}\n\nSubmission ${id}, form "${lead.form_title}", email ${lead.email}.\nAdd it by hand, or fix the cause and run: crm-connector retry ${id}`,
        replyTo: lead.email, messageId: `${id}.alert.${target.slice(4)}@crm-connector`,
      }, rt);
    } catch (e) {
      log(`${id}: the alert email failed too: ${e.message}`);
    }
  }

  // Run by a timer (Node) or a cron trigger (Workers): retries what is due, then deletes what is
  // past its retention.
  async function runDue() {
    const now = rt.now();
    const purged = await store.purge(now);
    const rows = await store.due(now, 100);
    const ids = [...new Set(rows.map((r) => r.submission_id))];
    for (const id of ids) await deliverSubmission(id);
    if (ids.length || purged) log(`retry pass: ${ids.length} submission(s) tried, ${purged} purged`);
    return { tried: ids.length, purged };
  }

  // Puts dead deliveries of one submission back in the queue, after a person fixed the cause.
  // The saved progress stays, so a CRM record that was created is not created twice.
  async function requeue(id) {
    const n = await store.requeue(id);
    await deliverSubmission(id);
    return n;
  }

  async function admin(request, path) {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!config.adminToken || !token || !(await timingSafeEqual(token, config.adminToken))) return json({ ok: false, error: 'unauthorized' }, 401);
    if (path === '/admin/status' && request.method === 'GET') return json({ ok: true, stats: await store.stats(), recent: await store.recent(20) });
    if (path === '/admin/retry' && request.method === 'POST') return json({ ok: true, ...(await runDue()) });
    return json({ ok: false, error: 'not_found' }, 404);
  }

  return { handle, submit, deliverSubmission, runDue, requeue };
}

// ---------------------------------------------------------------- helpers

async function timingSafeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

function originOf(u) {
  try { return u ? new URL(u).origin : null; } catch { return null; }
}

function safeRedirect(target, form) {
  const o = originOf(target);
  return o && form.allowedOrigins.includes(o) ? target : null;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

// The answer to a plain HTML form post, for browsers without JavaScript
function page(form, status, body) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const back = form.allowedOrigins[0];
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${body.ok ? 'Sent' : 'Not sent'}</title>
<body style="font:17px/1.6 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 16px;color:#1d1d1f;background:#fff">
<p>${esc(body.message || (body.ok ? 'Thank you.' : 'The form could not be sent.'))}</p><p><a href="${esc(back)}">Back to the website</a></p></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
