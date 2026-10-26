// Frappe REST (/api/resource): Dandirock, Frappe CRM and ERPNext all speak it, so one adapter with
// a preset per product covers the three. A record is matched on its email field, then a note
// document is inserted pointing at it.
// Auth: an API key and secret of a user allowed to create the lead and note doctypes.
import { request } from '../http.js';
import { resolveMap, patchFor, lines } from '../lead.js';

export const presets = {
  dandirock: {
    doctype: 'DR Lead',
    emailField: 'email',
    fields: {
      first_name: 'first_name', last_name: 'last_name', email: 'email', organization: 'company',
      job_title: 'job_title', phone: 'phone', website: 'website', language: 'language',
      request_message: 'message', landing_page: 'page_url',
      utm_source: 'utm_source', utm_medium: 'utm_medium', utm_campaign: 'utm_campaign',
    },
    onCreate: {
      source: { const: 'Website form' }, lead_type: { const: 'Inbound request' }, lead_list: { const: 'Website' },
      marketing_consent: 'consent_marketing',
    },
    // Written only when the visitor ticked the consent box, so the CRM keeps proof of what they agreed to and when
    onConsent: { consent_date: 'submitted_date', consent_wording: 'consent_text' },
    // A DR Lead needs a first name; the email address stands in until a person adds the real one
    requireOnCreate: { first_name: 'email' },
    note: {
      doctype: 'DR Note',
      fields: {
        reference_doctype: { const: 'DR Lead' }, reference_name: '$record', kind: { const: 'Note' },
        title: '$title', content: '$body', occurred_on: '$date',
      },
    },
  },
  'frappe-crm': {
    doctype: 'CRM Lead',
    emailField: 'email',
    fields: {
      first_name: 'first_name', last_name: 'last_name', email: 'email', organization: 'company',
      job_title: 'job_title', mobile_no: 'phone', website: 'website',
    },
    onCreate: {},
    requireOnCreate: { first_name: 'email' },
    note: {
      doctype: 'FCRM Note',
      fields: { reference_doctype: { const: 'CRM Lead' }, reference_docname: '$record', title: '$title', content: '$body' },
    },
  },
  erpnext: {
    doctype: 'Lead',
    emailField: 'email_id',
    fields: { first_name: 'first_name', last_name: 'last_name', email_id: 'email', company_name: 'company', job_title: 'job_title', phone: 'phone', website: 'website' },
    onCreate: { source: { const: 'Website' } },
    requireOnCreate: { first_name: 'email' },
    note: false, // ERPNext keeps notes in a child table on Lead; the request text goes to the Comment instead
    comment: true,
  },
};

export const defaults = { preset: 'dandirock' };

export async function deliver(lead, opts, ctx) {
  const p = { ...presets[opts.preset || 'dandirock'], ...opts };
  const h = { authorization: `token ${opts.apiKey}:${opts.apiSecret}` };
  const api = `${opts.baseUrl.replace(/\/$/, '')}/api/resource`;
  const doctype = encodeURIComponent(p.doctype);
  const values = resolveMap(p.fields, lead);
  if (values.marketing_consent !== undefined) values.marketing_consent = values.marketing_consent ? 1 : 0;
  const st = ctx.state;

  if (!st.recordId) {
    const q = new URLSearchParams({
      filters: JSON.stringify([[p.emailField, '=', lead.email]]),
      fields: JSON.stringify(['name', ...Object.keys(values), ...(p.onConsent ? ['marketing_consent'] : [])]),
      limit_page_length: '1',
    });
    const hit = (await request(ctx, 'GET', `${api}/${doctype}?${q}`, { headers: h }))?.data?.[0];
    if (hit) {
      const patch = patchFor(hit, values, opts.onExisting);
      // Consent given now is recorded on a lead that had none; a form without the tick never withdraws it
      if (p.onConsent && lead.consent_marketing && !Number(hit.marketing_consent)) Object.assign(patch, { marketing_consent: 1 }, resolveMap(p.onConsent, lead));
      else delete patch.marketing_consent;
      if (Object.keys(patch).length) await request(ctx, 'PUT', `${api}/${doctype}/${encodeURIComponent(hit.name)}`, { headers: h, json: patch });
      st.recordId = hit.name;
      st.action = 'updated';
    } else {
      const body = { ...values, ...resolveMap(p.onCreate, lead) };
      if (body.marketing_consent !== undefined) body.marketing_consent = body.marketing_consent ? 1 : 0;
      for (const [k, fallback] of Object.entries(p.requireOnCreate || {})) body[k] ||= lead[fallback];
      if (lead.consent_marketing) Object.assign(body, resolveMap(p.onConsent, lead));
      st.recordId = (await request(ctx, 'POST', `${api}/${doctype}`, { headers: h, json: body })).data.name;
      st.action = 'created';
    }
    await ctx.save();
  }

  const text = lines(lead).join('\n');
  if (p.note && !st.noteId) {
    const special = { $record: st.recordId, $title: ctx.noteTitle, $body: text, $date: lead.submitted_at.slice(0, 10) };
    const body = {};
    for (const [k, spec] of Object.entries(p.note.fields)) body[k] = typeof spec === 'string' && spec in special ? special[spec] : resolveMap({ v: spec }, lead).v;
    st.noteId = (await request(ctx, 'POST', `${api}/${encodeURIComponent(p.note.doctype)}`, { headers: h, json: body })).data.name;
  } else if (p.comment && !st.noteId) {
    st.noteId = (await request(ctx, 'POST', `${api}/Comment`, {
      headers: h, json: { comment_type: 'Comment', reference_doctype: p.doctype, reference_name: st.recordId, content: `${ctx.noteTitle}\n\n${text}` },
    })).data.name;
  }
  return { action: st.action, ref: `${p.doctype} ${st.recordId}` };
}
