// The canonical lead: every form, whatever its field names, becomes this shape before
// anything is sent. Adapters only ever read these keys, so a new form never needs a new adapter.

export const LEAD_KEYS = [
  'email', 'first_name', 'last_name', 'company', 'job_title', 'phone', 'website', 'message',
  'language', 'consent_marketing', 'consent_text', 'source', 'page_url', 'referrer',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
];

// Common spellings seen in the wild, mapped to the canonical key
const ALIASES = {
  mail: 'email', email_address: 'email', e_mail: 'email',
  firstname: 'first_name', first: 'first_name', given_name: 'first_name', prenom: 'first_name', vorname: 'first_name',
  lastname: 'last_name', last: 'last_name', surname: 'last_name', family_name: 'last_name', nom: 'last_name', nachname: 'last_name',
  organization: 'company', organisation: 'company', company_name: 'company', firma: 'company', entreprise: 'company',
  title: 'job_title', jobtitle: 'job_title', role: 'job_title', position: 'job_title',
  tel: 'phone', telephone: 'phone', mobile: 'phone', phone_number: 'phone',
  url: 'website', site: 'website',
  comments: 'message', comment: 'message', body: 'message', question: 'message', request: 'message',
  lang: 'language', locale: 'language',
  consent: 'consent_marketing', marketing_consent: 'consent_marketing', newsletter: 'consent_marketing', optin: 'consent_marketing',
};

const MAX_FIELD = 5000;
const MAX_EXTRA = 30;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

export function isEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
}

// Strip control characters (CR and LF included) from one-line values, so nothing a visitor
// types can add a header to an email or break a CRM field.
export function oneLine(v, max = 300) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function multiLine(v) {
  return String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_FIELD);
}

function truthy(v) {
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on', 'y'].includes(String(v ?? '').trim().toLowerCase());
}

export function canonicalKey(raw, formFields) {
  const k = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (formFields && formFields[raw]) return formFields[raw];
  if (formFields && formFields[k]) return formFields[k];
  if (LEAD_KEYS.includes(k)) return k;
  return ALIASES[k] || null;
}

// fields: the raw submitted fields (strings). form: the form's config. meta: what the server saw.
export function normalize(fields, form = {}, meta = {}) {
  const lead = { extra: {} };
  for (const [raw, value] of Object.entries(fields)) {
    if (raw.startsWith('_')) continue; // relay control fields (_id, _gotcha, _t, _redirect)
    const key = canonicalKey(raw, form.fields);
    if (key === 'message') lead.message = multiLine(value);
    else if (key === 'consent_marketing') lead.consent_marketing = truthy(value);
    else if (key) lead[key] = oneLine(value);
    else if (Object.keys(lead.extra).length < MAX_EXTRA) lead.extra[oneLine(raw, 60)] = multiLine(value);
  }
  if (fields.name && !lead.first_name && !lead.last_name) {
    const parts = oneLine(fields.name).split(' ');
    lead.first_name = parts.shift() || '';
    lead.last_name = parts.join(' ');
    delete lead.extra.name;
  }
  if (lead.email) lead.email = lead.email.toLowerCase();
  if (lead.website && !/^https?:\/\//i.test(lead.website)) lead.website = 'https://' + lead.website;
  lead.consent_marketing = Boolean(lead.consent_marketing);
  if (lead.consent_marketing && form.consent?.text && !lead.consent_text) lead.consent_text = form.consent.text;
  lead.form = form.id;
  lead.form_title = form.title || form.id;
  lead.source = lead.source || form.source || 'Website form';
  lead.page_url = lead.page_url || meta.referer || '';
  lead.submitted_at = meta.now || new Date().toISOString();
  lead.submitted_date = lead.submitted_at.slice(0, 10);
  for (const k of Object.keys(lead)) if (lead[k] === '' || lead[k] === undefined) delete lead[k];
  return lead;
}

// The value a form field name ended up as on the lead, whatever alias the form used
export function fieldValue(lead, name, form = {}) {
  const key = canonicalKey(name, form.fields);
  return key ? lead[key] : lead.extra?.[name];
}

export function fullName(lead) {
  return [lead.first_name, lead.last_name].filter(Boolean).join(' ');
}

export function displayName(lead) {
  return fullName(lead) || lead.email;
}

const LABELS = {
  email: 'Email', first_name: 'First name', last_name: 'Last name', company: 'Company', job_title: 'Role',
  phone: 'Phone', website: 'Website', language: 'Language', consent_marketing: 'Marketing consent',
  consent_text: 'Consent wording', page_url: 'Page', referrer: 'Referrer', utm_source: 'utm_source',
  utm_medium: 'utm_medium', utm_campaign: 'utm_campaign', utm_term: 'utm_term', utm_content: 'utm_content',
};

// The submission as plain lines, used for the notification email and the CRM note, so a field
// no adapter maps still reaches a person.
export function lines(lead) {
  const out = [];
  for (const [k, label] of Object.entries(LABELS)) {
    if (lead[k] === undefined) continue;
    out.push(`${label}: ${k === 'consent_marketing' ? (lead[k] ? 'yes' : 'no') : lead[k]}`);
  }
  for (const [k, v] of Object.entries(lead.extra || {})) out.push(`${k}: ${v}`);
  if (lead.message) out.push('', 'Message:', lead.message);
  return out;
}

// Mapping values: "lead_key", {"const": x}, or {"template": "Asked via {form_title}"}
export function resolveMap(map, lead) {
  const out = {};
  for (const [target, spec] of Object.entries(map || {})) {
    let v;
    if (spec === null || spec === false) continue;
    if (typeof spec === 'string') v = spec.startsWith('extra.') ? lead.extra?.[spec.slice(6)] : lead[spec];
    else if ('const' in spec) v = spec.const;
    else if ('template' in spec) v = spec.template.replace(/\{([\w.]+)\}/g, (_, k) => (k.startsWith('extra.') ? lead.extra?.[k.slice(6)] : lead[k]) ?? '').trim();
    if (v !== undefined && v !== null && v !== '') out[target] = v;
  }
  return out;
}

// Fill mode (default): only keys the CRM record has empty, so nothing a person typed is replaced.
// Overwrite mode: everything mapped. Skip mode: an existing record only gets the note.
export function patchFor(existing, values, mode) {
  if (mode === 'overwrite') return { ...values };
  if (mode === 'skip') return {};
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    const cur = existing?.[k];
    if (cur === undefined || cur === null || cur === '' || (Array.isArray(cur) && cur.length === 0)) out[k] = v;
  }
  return out;
}
