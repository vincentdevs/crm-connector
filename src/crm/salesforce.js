// Salesforce: an open (unconverted) Lead matched on email, then a completed Task on it that
// carries the submission. Auth: an External Client App with the client credentials flow, or a
// ready access token for testing.
import { request, DeliveryError } from '../http.js';
import { resolveMap, patchFor, lines } from '../lead.js';

export const defaults = {
  apiVersion: 'v61.0',
  fields: {
    Email: 'email', FirstName: 'first_name', LastName: 'last_name', Company: 'company', Title: 'job_title',
    Phone: 'phone', Website: 'website', LeadSource: { const: 'Web' },
  },
  note: true,
};

async function auth(opts, ctx) {
  if (opts.accessToken) return { token: opts.accessToken, instance: opts.instanceUrl };
  if (ctx.cache.sf && ctx.cache.sf.until > Date.now()) return ctx.cache.sf;
  if (!opts.clientId || !opts.clientSecret) throw new DeliveryError('salesforce: set clientId and clientSecret, or accessToken', { permanent: true });
  const r = await request(ctx, 'POST', `${opts.instanceUrl.replace(/\/$/, '')}/services/oauth2/token`, {
    form: { grant_type: 'client_credentials', client_id: opts.clientId, client_secret: opts.clientSecret },
  });
  ctx.cache.sf = { token: r.access_token, instance: r.instance_url || opts.instanceUrl, until: Date.now() + 50 * 60 * 1000 };
  return ctx.cache.sf;
}

const soql = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function deliver(lead, opts, ctx) {
  const { token, instance } = await auth(opts, ctx);
  const h = { authorization: `Bearer ${token}` };
  const api = `${instance.replace(/\/$/, '')}/services/data/${opts.apiVersion}`;
  const values = resolveMap(opts.fields, lead);
  const st = ctx.state;

  if (!st.recordId) {
    const fields = ['Id', ...Object.keys(values).filter((k) => k !== 'Id')];
    const q = `SELECT ${fields.join(', ')} FROM Lead WHERE Email = '${soql(lead.email)}' AND IsConverted = false ORDER BY CreatedDate DESC LIMIT 1`;
    const found = await request(ctx, 'GET', `${api}/query?q=${encodeURIComponent(q)}`, { headers: h });
    const hit = found?.records?.[0];
    if (hit) {
      const patch = patchFor(hit, values, opts.onExisting);
      if (Object.keys(patch).length) await request(ctx, 'PATCH', `${api}/sobjects/Lead/${hit.Id}`, { headers: h, json: patch });
      st.recordId = hit.Id;
      st.action = 'updated';
    } else {
      // LastName and Company are required on a Salesforce Lead; a web form often has neither
      values.LastName ||= lead.last_name || lead.first_name || lead.email.split('@')[0];
      values.Company ||= lead.company || '[not provided]';
      st.recordId = (await request(ctx, 'POST', `${api}/sobjects/Lead`, { headers: h, json: values })).id;
      st.action = 'created';
    }
    await ctx.save();
  }

  if (opts.note && !st.taskId) {
    st.taskId = (await request(ctx, 'POST', `${api}/sobjects/Task`, {
      headers: h,
      json: { WhoId: st.recordId, Subject: ctx.noteTitle.slice(0, 255), Description: lines(lead).join('\n').slice(0, 32000), Status: 'Completed', ActivityDate: lead.submitted_at.slice(0, 10) },
    })).id;
  }
  return { action: st.action, ref: `Lead ${st.recordId}` };
}
