// Cloudflare Workers runtime: D1 as the outbox, a cron trigger for retries, and SMTP over
// cloudflare:sockets. The config is the RELAY_CONFIG variable (JSON); "env:NAME" values in it
// are read from the Worker's secrets.
import { connect } from 'cloudflare:sockets';
import { createRelay } from '../core.js';
import { validate } from '../config.js';
import { sqlStore } from '../store/sql.js';
import { d1Driver } from '../store/drivers.js';

function wrap(socket) {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  return {
    read: async () => { const { value, done } = await reader.read(); return done ? null : value; },
    write: (bytes) => writer.write(bytes),
    startTls: async () => {
      reader.releaseLock();
      writer.releaseLock();
      return wrap(socket.startTls());
    },
    close: () => socket.close(),
  };
}

async function openSocket({ host, port, tls }) {
  const socket = connect({ hostname: host, port }, { secureTransport: tls === 'implicit' ? 'on' : tls === 'starttls' ? 'starttls' : 'off', allowHalfOpen: false });
  await socket.opened;
  return wrap(socket);
}

let ready = null;
const cache = {}; // lives as long as the isolate, so a Salesforce token is reused across requests
function relayFor(env, ctx) {
  // Built once per isolate; the schema is created on first use
  ready ||= (async () => {
    const raw = typeof env.RELAY_CONFIG === 'string' ? JSON.parse(env.RELAY_CONFIG) : env.RELAY_CONFIG;
    const config = validate(raw, env);
    const store = sqlStore(d1Driver(env.DB));
    await store.init();
    return { config, store };
  })().catch((e) => { ready = null; throw e; });
  return ready.then(({ config, store }) => createRelay({ config, store, runtime: { openSocket, cache, defer: (p) => ctx.waitUntil(p.catch(() => {})) } }));
}

export default {
  async fetch(request, env, ctx) {
    try {
      return (await relayFor(env, ctx)).handle(request);
    } catch (e) {
      console.error('[crm-connector]', e.message);
      return new Response('{"ok":false,"error":"config"}', { status: 500, headers: { 'content-type': 'application/json' } });
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((await relayFor(env, ctx)).runDue());
  },
};
