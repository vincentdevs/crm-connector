// Attio: a People record matched on email_addresses, then a note on it.
// Auth: an access token with record_permission:read-write and note:read-write.
import { request } from '../http.js';
import { resolveMap, patchFor, fullName, lines } from '../lead.js';

export const defaults = {
  baseUrl: 'https://api.attio.com',
  // Attio-specific values (name, email_addresses) are built below; these are plain text attributes
  fields: { job_title: 'job_title' },
  note: true,
};

export async function deliver(lead, opts, ctx) {
  const h = { authorization: `Bearer ${opts.token}` };
  const api = `${opts.baseUrl.replace(/\/$/, '')}/v2`;
  const st = ctx.state;
  const values = resolveMap(opts.fields, lead);
  const name = fullName(lead);
  if (name) values.name = [{ first_name: lead.first_name || '', last_name: lead.last_name || '', full_name: name }];
  if (lead.phone && opts.phone !== false) values.phone_numbers = [{ original_phone_number: lead.phone }];

  if (!st.recordId) {
    const found = await request(ctx, 'POST', `${api}/objects/people/records/query`, {
      headers: h, json: { filter: { email_addresses: lead.email }, limit: 1 },
    });
    const hit = found?.data?.[0];
    if (hit) {
      // Attio returns each attribute as a list of value objects; empty list means empty
      const current = Object.fromEntries(Object.entries(hit.values || {}).map(([k, v]) => [k, Array.isArray(v) && v.length ? v : null]));
      const patch = patchFor(current, values, opts.onExisting);
      if (Object.keys(patch).length) await request(ctx, 'PATCH', `${api}/objects/people/records/${hit.id.record_id}`, { headers: h, json: { data: { values: patch } } });
      st.recordId = hit.id.record_id;
      st.action = 'updated';
    } else {
      const made = await request(ctx, 'POST', `${api}/objects/people/records`, {
        headers: h, json: { data: { values: { email_addresses: [lead.email], ...values } } },
      });
      st.recordId = made.data.id.record_id;
      st.action = 'created';
    }
    await ctx.save();
  }

  if (opts.note && !st.noteId) {
    const made = await request(ctx, 'POST', `${api}/notes`, {
      headers: h,
      json: { data: { parent_object: 'people', parent_record_id: st.recordId, title: ctx.noteTitle, format: 'plaintext', content: lines(lead).join('\n') } },
    });
    st.noteId = made.data.id.note_id;
  }
  return { action: st.action, ref: `person ${st.recordId}` };
}
