// HubSpot: a contact matched on email, then a note on its timeline.
// Auth: a private app token with crm.objects.contacts.read/write (notes ride on the same scopes).
import { request } from '../http.js';
import { resolveMap, patchFor, lines } from '../lead.js';

export const defaults = {
  baseUrl: 'https://api.hubapi.com',
  fields: {
    email: 'email', firstname: 'first_name', lastname: 'last_name', company: 'company',
    jobtitle: 'job_title', phone: 'phone', website: 'website',
  },
  onCreate: { lifecyclestage: { const: 'lead' } },
  note: true,
};

export async function deliver(lead, opts, ctx) {
  const h = { authorization: `Bearer ${opts.token}` };
  const api = opts.baseUrl;
  const values = resolveMap(opts.fields, lead);
  const st = ctx.state;
  let action = st.action;

  if (!st.recordId) {
    const found = await request(ctx, 'POST', `${api}/crm/v3/objects/contacts/search`, {
      headers: h,
      json: { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: lead.email }] }], properties: Object.keys(values), limit: 1 },
    });
    const hit = found?.results?.[0];
    if (hit) {
      const patch = patchFor(hit.properties, values, opts.onExisting);
      if (Object.keys(patch).length) await request(ctx, 'PATCH', `${api}/crm/v3/objects/contacts/${hit.id}`, { headers: h, json: { properties: patch } });
      st.recordId = hit.id;
      action = 'updated';
    } else {
      const made = await request(ctx, 'POST', `${api}/crm/v3/objects/contacts`, {
        headers: h, json: { properties: { ...values, ...resolveMap(opts.onCreate, lead) } },
      });
      st.recordId = made.id;
      action = 'created';
    }
    st.action = action;
    await ctx.save();
  }

  if (opts.note && !st.noteId) {
    const body = `<p><strong>${esc(ctx.noteTitle)}</strong></p>` + lines(lead).map((l) => `<p>${esc(l)}</p>`).join('');
    const note = await request(ctx, 'POST', `${api}/crm/v3/objects/notes`, {
      headers: h,
      json: {
        properties: { hs_timestamp: lead.submitted_at, hs_note_body: body },
        // 202 is HubSpot's defined association type for note to contact
        associations: [{ to: { id: st.recordId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
      },
    });
    st.noteId = note.id;
  }
  return { action, ref: `contact ${st.recordId}` };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
