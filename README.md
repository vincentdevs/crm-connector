# CRM Connector

CRM Connector sits between a website form and the tools that handle the lead. A visitor submits a form, the relay checks it and stores it, pushes the person into one or more CRMs, then emails the team with the submission and where it landed. It runs on Node or as a Cloudflare Worker, has no dependencies, and is driven by one JSON config, so the same code serves any site and any CRM.

It is for anyone who wants form leads to reach a CRM without paying for a form SaaS, and without losing a lead when the CRM API is down for an hour.

For a step-by-step explanation of what happens to a submission, why each step is built that way and how failures are handled, read [How CRM Connector works](docs/HOW_IT_WORKS.md).

## Try it in two minutes

```bash
git clone https://github.com/vincentdevs/crm-connector.git && cd crm-connector
npm test                                          # 16 tests against simulated CRMs, no account needed
cp relay.config.example.json relay.config.json    # then keep only the forms and CRMs you use
node src/cli.js check
```

Requires Node 22.5 or newer. There is nothing to install.

## How a submission travels

1. **Check.** The relay refuses posts from sites not listed in `allowedOrigins`, bodies over 32 KB, a missing or malformed email, missing required fields and missing consent when the form requires it. Bots that fill the hidden honeypot field, or post less than 1.5 seconds after the page loaded, get the same success answer as a person, and nothing is stored. Each connection is limited to 20 submissions an hour by default.
2. **Store.** The submission goes into an outbox (SQLite on Node, D1 on Workers) with one delivery row per target, before anything is sent. If the browser retries because a response was lost, the same `_id` returns the first submission instead of creating a second one.
3. **CRMs.** Each CRM listed on the form, in order: find the person by email, create them or fill the fields they have empty, then add a note holding the whole submission, including fields no mapping covers. Every step saves its progress, so a retry after a half-finished push resumes at the note instead of creating a second record.
4. **Email.** The notification goes to the team after the CRMs, so it says "hubspot: created, contact 123" or "not yet, will retry". Reply-To is the visitor.

Failures are retried after 1, 2, 4, 8 minutes and so on, up to 6 hours apart, for 8 attempts. A 400 or 422 means the CRM rejected the data itself, so the relay stops at once and emails a person instead of retrying. Submissions are deleted after `retentionDays` (30 by default), because the CRM is the record that lasts.

## CRMs

| `type` | What it writes | Credentials |
|---|---|---|
| `hubspot` | Contact matched on email, note on its timeline | Private app token with contacts read and write |
| `pipedrive` | Person matched on email, organization matched on name, a lead in the Leads inbox, a note | API token |
| `salesforce` | Open Lead matched on email, a completed Task carrying the submission | Client credentials (External Client App), or an access token |
| `attio` | People record matched on email, a note | Access token with records and notes read and write |
| `dandirock` | DR Lead (source "Website form", type "Inbound request", list "Website"), consent with date and wording, DR Note | API key and secret |
| `frappe-crm`, `erpnext` | CRM Lead or Lead, with FCRM Note or a Comment | API key and secret |
| `webhook` | A signed JSON POST to Zapier, Make, n8n or any endpoint, which covers every other CRM | Optional HMAC secret |

`onExisting` sets what happens when the email already exists: `fill` (default) writes only empty fields, `overwrite` writes every mapped field, `skip` only adds the note. Marketing consent is added when given later and never removed by a form without the tick.

The default field maps sit at the top of each file in `src/crm/`. To change one, add a `fields` object to the CRM in the config. It extends the default map, a value of `null` removes a default, and a value can be a lead field (`"job_title"`), a constant (`{"const": "Web"}`) or a template (`{"template": "{form_title} on {page_url}"}`).

## Run it on Node

```bash
cp relay.config.example.json relay.config.json   # keep the forms and CRMs you use
echo 'HUBSPOT_TOKEN=...' >> .env                  # every "env:NAME" in the config
node src/cli.js check                             # lists every problem at once
node src/cli.js test-crm hubspot                  # pushes one test lead, then delete it
node src/cli.js test-notify sales                 # sends one test email
node src/cli.js serve --port 8787
```

Put it behind a reverse proxy with HTTPS and start it with `TRUST_PROXY=1`, so the rate limit reads the visitor's address from `X-Forwarded-For`.

`node src/cli.js status` prints counts per target and the last ten submissions. `node src/cli.js retry <id>` puts a dead submission back in the queue after you fixed its cause.

## Run it on Cloudflare Workers

Copy `wrangler.example.jsonc` to `wrangler.jsonc`, create the database with `npx wrangler d1 create crm-connector`, paste its id, put the config under `vars.RELAY_CONFIG`, set each `env:` secret with `npx wrangler secret put NAME`, and run `npx wrangler deploy`. The cron trigger runs retries and the purge every five minutes. SMTP goes out through `cloudflare:sockets` on port 465 or 587.

## Connect a form

Point the form at `/f/<form id>` and add the script. Without JavaScript, the same form still posts and the relay redirects to `successUrl`.

```html
<form action="https://relay.example.com/f/contact" method="post" data-crm-connector
      data-success="Thank you, we will answer within one working day.">
  <input name="first_name" required>
  <input name="email" type="email" required>
  <textarea name="message"></textarea>
  <label><input type="checkbox" name="consent"> Send me the newsletter</label>
  <p data-relay-error hidden></p>
  <button type="submit">Send</button>
</form>
<script src="https://relay.example.com/embed.js" defer></script>
```

The script adds the `_id`, the honeypot and the load time, sends UTM parameters, the page URL and the referrer, and fires a `crm-connector:sent` event on success. Field names are matched loosely: `firstname`, `prenom` and `vorname` all become `first_name`, and `company`, `firma` and `entreprise` become `company`. Unknown fields are kept and appear in the note and the email.

## Admin API

`GET /admin/status` and `POST /admin/retry`, with `Authorization: Bearer <adminToken>`. Without an `adminToken` in the config, both stay closed.

## Personal data

The relay stores the submission, a salted hash of the visitor's IP address (for the rate limit) and the delivery log, and deletes all of it after `retentionDays`. Set `consent.text` on any form with a consent box, so the CRM records the exact wording the visitor agreed to.

## Tests

`npm test` runs 16 tests against simulated HubSpot, Pipedrive, Salesforce, Attio, Frappe and webhook APIs and a fake SMTP server. `node test/worker-smoke.mjs` runs the Worker build in wrangler's local runtime with D1 and socket SMTP. The simulations check the relay's own logic and the request shapes taken from each vendor's API documentation. Only a run with `test-crm` against a real account proves a vendor accepts them, and as of 26 October 2026 that has been done for Dandirock only.
