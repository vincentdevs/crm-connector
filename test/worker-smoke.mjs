// Runs the Worker build in wrangler dev (workerd, local D1) against the same mocks, to prove the
// Workers runtime, D1 driver and cloudflare:sockets SMTP path work, not only the Node one.
// Usage: node test/worker-smoke.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmMock, startSmtpMock, bodyOf } from './mocks.js';

const crm = await startCrmMock();
const smtp = await startSmtpMock();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-relay-worker-'));
const port = 8799;
const ORIGIN = 'https://site.example';
const config = {
  salt: 'env:RELAY_SALT', adminToken: 'env:RELAY_ADMIN_TOKEN',
  forms: { contact: { title: 'Contact form', allowedOrigins: [ORIGIN], crm: ['hubspot', 'dandirock'], notify: 'team' } },
  crms: {
    hubspot: { type: 'hubspot', token: 'env:HS', baseUrl: `${crm.base}/hubspot` },
    dandirock: { type: 'dandirock', baseUrl: `${crm.base}/frappe`, apiKey: 'fk', apiSecret: 'env:FS' },
  },
  notify: { team: { transport: 'smtp', to: ['team@site.example'], from: 'forms@site.example', smtp: { host: '127.0.0.1', port: smtp.port, tls: 'off', user: 'u', pass: 'p' } } },
};
fs.writeFileSync(path.join(dir, 'wrangler.json'), JSON.stringify({
  name: 'lead-relay-smoke', main: path.resolve('src/runtime/worker.js'), compatibility_date: '2025-09-01',
  d1_databases: [{ binding: 'DB', database_name: 'smoke', database_id: '00000000-0000-0000-0000-000000000000' }],
  vars: { RELAY_CONFIG: config },
}));
fs.writeFileSync(path.join(dir, '.dev.vars'), 'RELAY_SALT=s\nRELAY_ADMIN_TOKEN=adm\nHS=hs-token\nFS=fs\n');

const wr = spawn('npx', ['wrangler@4.92.0', 'dev', '-c', path.join(dir, 'wrangler.json'), '--port', String(port), '--persist-to', path.join(dir, 'state'), '--show-interactive-dev-session=false'], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
wr.stdout.on('data', (d) => { out += d; });
wr.stderr.on('data', (d) => { out += d; });
const fail = async (msg) => { console.error('FAIL:', msg, '\n--- wrangler output ---\n', out.slice(-3000)); wr.kill(); await crm.close(); await smtp.close(); process.exit(1); };

const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
  if (i > 90) await fail('wrangler dev did not start');
  await new Promise((r) => setTimeout(r, 1000));
}
const res = await fetch(`${base}/f/contact`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ _id: 'worker-smoke-0001', name: 'Worker Smoke', email: 'smoke@site.example', company: 'Edge', message: 'From workerd.' }) });
const body = await res.json();
if (!body.ok) await fail(`submit answered ${res.status} ${JSON.stringify(body)}`);
for (let i = 0; ; i++) {
  const st = await (await fetch(`${base}/admin/status`, { headers: { authorization: 'Bearer adm' } })).json();
  const d = st.recent?.[0]?.deliveries || [];
  if (d.length && d.every((x) => x.status === 'done')) { console.log('deliveries:', d.map((x) => `${x.target}=${x.status}`).join(', ')); break; }
  if (d.some((x) => x.status === 'dead' || x.status === 'failed')) await fail(`delivery failed: ${JSON.stringify(d)}`);
  if (i > 30) await fail(`deliveries not done: ${JSON.stringify(d)}`);
  await new Promise((r) => setTimeout(r, 500));
}
const hs = crm.db.hubspot.contacts.find((c) => c.properties.email === 'smoke@site.example');
const dr = crm.db.frappe['DR Lead']?.find((l) => l.email === 'smoke@site.example');
const mail = smtp.messages.at(-1);
if (!hs || !dr || !mail) await fail(`missing: hubspot=${!!hs} dandirock=${!!dr} mail=${!!mail}`);
console.log('hubspot contact', hs.id, '| dandirock', dr.name, '| email:', bodyOf(mail).text.split('\n').filter((l) => l.startsWith('hubspot') || l.startsWith('dandirock')).join(' / '));
console.log('WORKER SMOKE PASS');
wr.kill();
await crm.close();
await smtp.close();
fs.rmSync(dir, { recursive: true, force: true });
