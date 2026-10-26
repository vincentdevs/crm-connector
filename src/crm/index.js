// Adapter registry. An adapter is a module with `defaults` and `deliver(lead, opts, ctx)`.
// deliver() matches a record on email, creates or fills it, adds a note, and returns
// { action, ref }. It writes its progress to ctx.state and calls ctx.save() after each step, so a
// retry after a partial failure resumes where it stopped instead of creating a second note.
import * as hubspot from './hubspot.js';
import * as pipedrive from './pipedrive.js';
import * as salesforce from './salesforce.js';
import * as attio from './attio.js';
import * as frappe from './frappe.js';
import * as webhook from './webhook.js';

export const adapters = { hubspot, pipedrive, salesforce, attio, frappe, webhook };

// "dandirock" and "frappe-crm" are the frappe adapter with a preset, named for convenience
export const aliases = { dandirock: ['frappe', { preset: 'dandirock' }], 'frappe-crm': ['frappe', { preset: 'frappe-crm' }], erpnext: ['frappe', { preset: 'erpnext' }] };

export const REQUIRED = {
  hubspot: ['token'], pipedrive: ['token'], salesforce: ['instanceUrl'], attio: ['token'],
  frappe: ['baseUrl', 'apiKey', 'apiSecret'], webhook: ['url'],
};

export function resolveAdapter(target) {
  let type = target.type;
  let extra = {};
  if (aliases[type]) [type, extra] = aliases[type];
  const mod = adapters[type];
  if (!mod) throw new Error(`unknown CRM type "${target.type}" (known: ${[...Object.keys(adapters), ...Object.keys(aliases)].join(', ')})`);
  const merged = { onExisting: 'fill', ...mod.defaults, ...extra, ...target };
  // A fields map in the config extends the default map rather than replacing it; null removes a default
  if (mod.defaults.fields && target.fields) merged.fields = { ...mod.defaults.fields, ...target.fields };
  return { type, mod, opts: merged };
}
