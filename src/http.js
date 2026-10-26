// One request helper for every adapter, so retry decisions are made in one place.
// A 400 or 422 means the CRM rejected the data itself and sending it again changes nothing, so it
// is permanent. Anything else (401 after a key rotation, 429, 5xx, a dropped connection) is retried.

export class DeliveryError extends Error {
  constructor(message, { status = 0, permanent = false } = {}) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

const PERMANENT = new Set([400, 405, 413, 415, 422]);

export async function request(ctx, method, url, { headers = {}, json, form, timeoutMs = 15000 } = {}) {
  const init = { method, headers: { accept: 'application/json', ...headers } };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['content-type'] = 'application/json';
  } else if (form !== undefined) {
    init.body = new URLSearchParams(form).toString();
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  init.signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await (ctx.fetch || fetch)(url, init);
  } catch (err) {
    throw new DeliveryError(`${method} ${redact(url)}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
  }
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new DeliveryError(`${method} ${redact(url)} -> ${res.status} ${String(detail).slice(0, 300)}`,
      { status: res.status, permanent: PERMANENT.has(res.status) });
  }
  return body;
}

// Never let a key that rides in a query string reach a log or the database
function redact(url) {
  return String(url).replace(/(api_token|api_key|token|key)=[^&]+/gi, '$1=***');
}
