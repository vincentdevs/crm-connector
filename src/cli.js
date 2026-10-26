#!/usr/bin/env node
// crm-connector serve | check | test-crm <name> | test-notify <name> | status | retry [id]
import fs from 'node:fs';
import path from 'node:path';
import { validate } from './config.js';
import { startNode, openSocket } from './runtime/node.js';
import { resolveAdapter } from './crm/index.js';
import { normalize } from './lead.js';
import { compose, send } from './notify/index.js';
import { createRelay } from './core.js';
import { sqlStore } from './store/sql.js';
import { sqliteDriver } from './store/drivers.js';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : dflt;
};
const configPath = flag('config', process.env.RELAY_CONFIG_PATH || 'relay.config.json');
const dbPath = flag('db', process.env.RELAY_DB || 'crm-connector.db');
const port = Number(flag('port', process.env.PORT || 8787));
const host = flag('host', process.env.HOST || '127.0.0.1');
const [cmd, arg] = args;

// Reads .env next to the config when present, without overriding what the shell already set
function loadDotEnv(dir) {
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function load() {
  loadDotEnv(path.dirname(path.resolve(configPath)));
  return validate(JSON.parse(fs.readFileSync(configPath, 'utf8')), process.env);
}

// A lead that is obviously a test, so it is easy to find and delete in the CRM afterwards
function testLead(cfg) {
  const form = Object.values(cfg.forms)[0];
  return normalize({
    email: process.env.RELAY_TEST_EMAIL || 'crm-connector-test@example.com', first_name: 'Test', last_name: 'CRM Connector',
    company: 'CRM Connector test', job_title: 'Tester', message: 'A test sent by crm-connector test-crm. Safe to delete.',
  }, { ...form, title: `${form.title || form.id} (test)` }, { now: new Date().toISOString() });
}

async function main() {
  switch (cmd) {
    case 'check': {
      const cfg = load();
      console.log(`Config OK: ${Object.keys(cfg.forms).length} form(s), CRMs: ${Object.keys(cfg.crms || {}).join(', ') || 'none'}, notify: ${Object.keys(cfg.notify || {}).join(', ') || 'none'}`);
      for (const [id, f] of Object.entries(cfg.forms)) console.log(`  /f/${id}  ->  ${[...(f.crm || []), ...(f.notify ? [`email (${f.notify})`] : [])].join(', ')}  from ${f.allowedOrigins.join(', ')}`);
      return;
    }
    case 'serve': {
      const cfg = load();
      const node = await startNode({ config: cfg, dbPath, port, host, trustProxy: process.env.TRUST_PROXY === '1' });
      console.log(`crm-connector listening on ${node.url}  (forms: ${Object.keys(cfg.forms).map((f) => `/f/${f}`).join(', ')})`);
      const stop = async () => { await node.close(); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'test-crm': {
      const cfg = load();
      if (!cfg.crms?.[arg]) throw new Error(`No CRM named "${arg}". Defined: ${Object.keys(cfg.crms || {}).join(', ')}`);
      const { mod, opts } = resolveAdapter(cfg.crms[arg]);
      const lead = testLead(cfg);
      const state = {};
      const r = await mod.deliver(lead, opts, { state, cache: {}, save: async () => {}, submissionId: 'test-' + Date.now(), noteTitle: `Test from crm-connector (${lead.form_title})` });
      console.log(`${arg}: ${r.action}, ${r.ref}. Look for ${lead.email} in the CRM and delete it when done.`);
      return;
    }
    case 'test-notify': {
      const cfg = load();
      const n = cfg.notify?.[arg];
      if (!n) throw new Error(`No notify named "${arg}". Defined: ${Object.keys(cfg.notify || {}).join(', ')}`);
      const lead = testLead(cfg);
      const { subject, text } = compose(lead, n, [{ target: 'example', status: 'done', action: 'created', ref: 'test' }], 'test-' + Date.now());
      const via = await send(n, { subject: `[test] ${subject}`, text, replyTo: lead.email, messageId: `test-${Date.now()}@crm-connector` }, { openSocket, fetch, log: console.log });
      console.log(`Sent to ${[].concat(n.to).join(', ')} via ${via}.`);
      return;
    }
    case 'status':
    case 'retry': {
      const cfg = load();
      const driver = await sqliteDriver(dbPath);
      const store = sqlStore(driver);
      await store.init();
      if (cmd === 'status') {
        for (const r of await store.stats()) console.log(`${r.target.padEnd(24)} ${r.status.padEnd(8)} ${r.n}`);
        console.log('');
        for (const s of await store.recent(10)) {
          console.log(`${new Date(s.created_at).toISOString()}  ${s.id}  ${s.form}  ${s.email}`);
          for (const d of s.deliveries) console.log(`    ${d.target.padEnd(20)} ${d.status.padEnd(7)} ${d.result ? JSON.stringify(d.result) : d.error || ''}`);
        }
      } else {
        const relay = createRelay({ config: cfg, store, runtime: { openSocket } });
        if (arg) console.log(`Requeued ${await relay.requeue(arg)} delivery(ies) of ${arg}.`);
        else console.log(await relay.runDue());
        for (const d of arg ? await store.deliveries(arg) : []) console.log(`    ${d.target.padEnd(20)} ${d.status.padEnd(7)} ${d.result ? JSON.stringify(d.result) : d.error || ''}`);
      }
      driver.close();
      return;
    }
    default:
      console.log(`crm-connector: form submission -> CRM -> email notification

  crm-connector check                 validate the config and list the forms
  crm-connector serve                 run the relay (default http://127.0.0.1:8787)
  crm-connector test-crm <name>       push one test lead to a CRM from the config
  crm-connector test-notify <name>    send one test notification email
  crm-connector status                counts per target and the last 10 submissions
  crm-connector retry [id]            run due retries now, or requeue one submission

Options: --config relay.config.json  --db crm-connector.db  --port 8787  --host 127.0.0.1`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
