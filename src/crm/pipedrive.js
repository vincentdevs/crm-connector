// Pipedrive: a person matched on email, its organization matched on name, a lead in the Leads
// inbox for this request, and a note carrying the whole submission.
// Auth: a personal API token, sent in the x-api-token header rather than the query string.
import { request } from '../http.js';
import { fullName, lines } from '../lead.js';

export const defaults = {
  baseUrl: 'https://api.pipedrive.com',
  createLead: true,
  leadTitle: { template: '{form_title}: {company}' },
  note: true,
};

export async function deliver(lead, opts, ctx) {
  const h = { 'x-api-token': opts.token };
  const api = opts.baseUrl.replace(/\/$/, '');
  const st = ctx.state;

  if (lead.company && st.orgId === undefined) {
    const q = new URLSearchParams({ term: lead.company, exact_match: 'true', limit: '1' });
    const found = await request(ctx, 'GET', `${api}/v1/organizations/search?${q}`, { headers: h });
    st.orgId = found?.data?.items?.[0]?.item?.id
      ?? (await request(ctx, 'POST', `${api}/v1/organizations`, { headers: h, json: { name: lead.company } })).data.id;
    await ctx.save();
  }

  if (!st.personId) {
    const q = new URLSearchParams({ term: lead.email, fields: 'email', exact_match: 'true', limit: '1' });
    const found = await request(ctx, 'GET', `${api}/v1/persons/search?${q}`, { headers: h });
    const hit = found?.data?.items?.[0]?.item;
    if (hit) {
      st.personId = hit.id;
      st.action = 'updated';
      // Fill the organization only when the person has none, never move them to another one
      if (st.orgId && !hit.organization) await request(ctx, 'PUT', `${api}/v1/persons/${hit.id}`, { headers: h, json: { org_id: st.orgId } });
    } else {
      const body = { name: fullName(lead) || lead.email, email: [{ value: lead.email, primary: true, label: 'work' }] };
      if (lead.phone) body.phone = [{ value: lead.phone, primary: true, label: 'work' }];
      if (st.orgId) body.org_id = st.orgId;
      st.personId = (await request(ctx, 'POST', `${api}/v1/persons`, { headers: h, json: body })).data.id;
      st.action = 'created';
    }
    await ctx.save();
  }

  if (opts.createLead && !st.leadId) {
    const title = (opts.leadTitle.template || '{form_title}').replace(/\{(\w+)\}/g, (_, k) => lead[k] ?? '').replace(/[:\s]+$/, '') || lead.email;
    const body = { title, person_id: st.personId };
    if (st.orgId) body.organization_id = st.orgId;
    st.leadId = (await request(ctx, 'POST', `${api}/v1/leads`, { headers: h, json: body })).data.id;
    await ctx.save();
  }

  if (opts.note && !st.noteId) {
    const body = { content: [ctx.noteTitle, '', ...lines(lead)].map(esc).join('<br>'), person_id: st.personId };
    if (st.leadId) body.lead_id = st.leadId;
    st.noteId = (await request(ctx, 'POST', `${api}/v1/notes`, { headers: h, json: body })).data.id;
  }
  return { action: st.action, ref: `person ${st.personId}${st.leadId ? `, lead ${st.leadId}` : ''}` };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
