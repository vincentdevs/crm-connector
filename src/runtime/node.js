// Node runtime: an HTTP server, a SQLite outbox and a retry timer. Needs Node 22.5 or later.
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { createRelay } from '../core.js';
import { sqlStore } from '../store/sql.js';
import { sqliteDriver } from '../store/drivers.js';

// Wraps a Node socket in the small interface the SMTP client expects
function wrap(sock, host) {
  const chunks = [];
  let waiting = null;
  let ended = false;
  let failure = null;
  const wake = () => { if (waiting) { const w = waiting; waiting = null; w(); } };
  const onData = (d) => { chunks.push(new Uint8Array(d)); wake(); };
  const onEnd = () => { ended = true; wake(); };
  const onError = (e) => { failure = e; wake(); };
  sock.on('data', onData);
  sock.on('end', onEnd);
  sock.on('close', onEnd);
  sock.on('error', onError);
  return {
    async read() {
      for (;;) {
        if (chunks.length) return chunks.shift();
        if (failure) throw failure;
        if (ended) return null;
        await new Promise((r) => { waiting = r; });
      }
    },
    write: (bytes) => new Promise((res, rej) => sock.write(bytes, (e) => (e ? rej(e) : res()))),
    async startTls() {
      sock.off('data', onData);
      const secured = tls.connect({ socket: sock, servername: host });
      await new Promise((res, rej) => { secured.once('secureConnect', res); secured.once('error', rej); });
      return wrap(secured, host);
    },
    close: async () => sock.end(),
  };
}

export async function openSocket({ host, port, tls: mode }) {
  const sock = mode === 'implicit' ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  await new Promise((res, rej) => {
    sock.once(mode === 'implicit' ? 'secureConnect' : 'connect', res);
    sock.once('error', rej);
  });
  return wrap(sock, host);
}

async function toRequest(req, base) {
  const body = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) break; // the relay rejects anything over 32 KB anyway
    body.push(c);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  return new Request(new URL(req.url, base), { method: req.method, headers, body: hasBody ? Buffer.concat(body) : undefined });
}

export async function startNode({ config, dbPath = 'crm-connector.db', port = 8787, host = '127.0.0.1', retryEveryMs = 60_000, trustProxy = false, runtime = {} } = {}) {
  const driver = await sqliteDriver(dbPath);
  const store = sqlStore(driver);
  await store.init();
  const pending = new Set();
  const relay = createRelay({
    config, store,
    runtime: {
      openSocket,
      // Behind a reverse proxy the visitor's address is in X-Forwarded-For; trust it only when told to
      clientIp: (r) => (trustProxy ? (r.headers.get('x-forwarded-for') || '').split(',')[0].trim() : r.headers.get('x-relay-peer')) || '',
      defer: (p) => { const q = p.catch(() => {}).finally(() => pending.delete(q)); pending.add(q); },
      ...runtime,
    },
  });
  const base = `http://${host}:${port}`;
  const server = http.createServer(async (req, res) => {
    try {
      req.headers['x-relay-peer'] = req.socket.remoteAddress || '';
      const response = await relay.handle(await toRequest(req, base));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error('[crm-connector] request failed', e);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"ok":false,"error":"server"}');
    }
  });
  await new Promise((r) => server.listen(port, host, r));
  const timer = retryEveryMs ? setInterval(() => relay.runDue().catch((e) => console.error('[crm-connector] retry pass failed', e)), retryEveryMs) : null;
  timer?.unref();
  return {
    relay, store, url: `http://${host}:${server.address().port}`,
    // Resolves once every delivery started so far has finished; used by tests and the CLI
    settle: async () => { while (pending.size) await Promise.all([...pending]); },
    close: async () => {
      if (timer) clearInterval(timer);
      await new Promise((r) => server.close(r));
      await Promise.all([...pending]);
      driver.close();
    },
  };
}
