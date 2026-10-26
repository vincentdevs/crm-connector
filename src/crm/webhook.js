// Any CRM without a native adapter: a signed JSON POST to Zapier, Make, n8n, Close, or your own
// endpoint. The receiver checks X-Relay-Signature = "sha256=" + HMAC-SHA256(secret, timestamp + "." + body)
// and rejects timestamps older than five minutes, so a captured request cannot be replayed.
import { request } from '../http.js';

export const defaults = { headers: {} };

export async function sign(secret, timestamp, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return 'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function deliver(lead, opts, ctx) {
  const payload = { event: 'lead.submitted', submission_id: ctx.submissionId, title: ctx.noteTitle, lead };
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { ...opts.headers, 'content-type': 'application/json', 'x-relay-timestamp': ts, 'idempotency-key': ctx.submissionId };
  if (opts.secret) headers['x-relay-signature'] = await sign(opts.secret, ts, body);
  // The body is already a string, so send it as is to keep the signed bytes identical
  const res = await request({ fetch: (u, init) => (ctx.fetch || fetch)(u, { ...init, body }) }, 'POST', opts.url, { headers });
  return { action: 'sent', ref: (res && (res.id || res.request_id)) ? String(res.id || res.request_id) : opts.url.replace(/^(https?:\/\/[^/]+).*/, '$1') };
}
