// Config is one JSON file. Secrets never sit in it: any string "env:NAME" is read from the
// environment (process.env on Node, Worker secrets on Cloudflare) when the relay starts.
import { REQUIRED, resolveAdapter } from './crm/index.js';

export function resolveEnv(value, env, path = '', missing = null) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const name = value.slice(4);
    if (env[name] === undefined || env[name] === '') {
      const msg = `${path}: environment variable ${name} is not set`;
      if (!missing) throw new Error(msg);
      missing.push(msg);
    }
    return env[name];
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveEnv(v, env, `${path}[${i}]`, missing));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnv(v, env, path ? `${path}.${k}` : k, missing)]));
  }
  return value;
}

// Throws one error listing every problem, so a broken config is fixed in one pass
export function validate(raw, env) {
  const errors = [];
  const cfg = resolveEnv(raw, env, '', errors);
  if (!cfg.forms || typeof cfg.forms !== 'object' || !Object.keys(cfg.forms).length) errors.push('config: "forms" needs at least one form');
  const crms = cfg.crms || {};
  for (const [name, t] of Object.entries(crms)) {
    try {
      const { type } = resolveAdapter(t);
      for (const k of REQUIRED[type]) if (!t[k] && !String(raw.crms[name][k] ?? "").startsWith("env:")) errors.push(`crms.${name}: "${k}" is required for ${t.type}`);
      if (type === 'salesforce' && !t.accessToken && !(t.clientId && t.clientSecret)) errors.push(`crms.${name}: give accessToken, or clientId and clientSecret`);
      if (t.onExisting && !['fill', 'overwrite', 'skip'].includes(t.onExisting)) errors.push(`crms.${name}: onExisting is fill, overwrite or skip`);
    } catch (e) { errors.push(`crms.${name}: ${e.message}`); }
  }
  const notify = cfg.notify || {};
  for (const [name, n] of Object.entries(notify)) {
    if (!n.to || ![].concat(n.to).length) errors.push(`notify.${name}: "to" is required`);
    if (!['smtp', 'resend', 'postmark', 'log'].includes(n.transport)) errors.push(`notify.${name}: transport is smtp, resend, postmark or log`);
    if (n.transport !== 'log' && !n.from) errors.push(`notify.${name}: "from" is required`);
    if (n.transport === 'smtp' && !n.smtp?.host) errors.push(`notify.${name}: smtp.host is required`);
    if (['resend', 'postmark'].includes(n.transport) && !n.apiKey) errors.push(`notify.${name}: apiKey is required`);
  }
  for (const [id, f] of Object.entries(cfg.forms || {})) {
    f.id = id;
    for (const c of f.crm || []) if (!crms[c]) errors.push(`forms.${id}: crm "${c}" is not defined under "crms"`);
    if (f.notify && !notify[f.notify]) errors.push(`forms.${id}: notify "${f.notify}" is not defined under "notify"`);
    if (!f.allowedOrigins?.length) errors.push(`forms.${id}: allowedOrigins is required (the sites allowed to post this form)`);
    if (f.consent?.required && !f.consent.field) f.consent.field = 'consent_marketing';
  }
  if (errors.length) {
    const e = new Error('Invalid config:\n  - ' + errors.join('\n  - '));
    e.errors = errors;
    throw e;
  }
  cfg.retentionDays ??= 30;
  cfg.maxAttempts ??= 8;
  cfg.rateLimitPerHour ??= 20;
  return cfg;
}
