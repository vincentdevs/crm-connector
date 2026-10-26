# How CRM Connector Works

This file explains what happens to a single form submission from the moment a visitor presses Send, and why each step is built the way it is. The README covers setup; this file is for anyone who wants to understand the design before trusting it with real leads.

## The problem it solves

A contact form has three jobs: the lead must reach the CRM your team works from, the team must hear about it quickly, and the visitor must get an answer at once. Most hand-written form handlers do all three inside the same request, so when the CRM API is down or the mail server rejects a login, the lead is lost and nobody finds out. That happened on torke.tech in October 2026, when the site's mail settings were missing and every form email had been failing silently.

CRM Connector separates those jobs. The visitor's answer depends only on the submission being saved. Delivery to the CRM and the email happens afterwards, from a saved copy, and is retried until it succeeds or a person is told.

## The path of one submission

```
browser form ──POST /f/contact──▶ 1. check ──▶ 2. save to outbox ──▶ visitor gets "thank you"
                                                     │
                                                     ▼
                                   3. each CRM in order ──▶ 4. email to the team
                                                     │
                                         failure? retry later, then alert a person
```

### 1. Check

The connector refuses anything it should never store: a post from a website not listed in `allowedOrigins`, a body over 32 KB, a missing or malformed email address, a missing required field, or a missing consent tick when the form requires one.

Bots are handled differently from people. The embed script adds a hidden field that people never see and a timestamp of when the page loaded. A submission that fills the hidden field, or arrives less than 1.5 seconds after the page opened, gets the same success answer a person would get, but nothing is stored or sent. Answering bots with an error would teach them to adapt. Each connection is also limited to 20 submissions an hour by default, counted against a salted hash of the IP address rather than the address itself.

### 2. Save to the outbox

Before anything leaves the server, the submission is written to a small database: SQLite when it runs on Node, D1 when it runs on Cloudflare Workers. One delivery row is created per destination, for example one for HubSpot and one for the email.

This write is the commit point. Once it succeeds, the visitor gets their answer, and nothing that happens later can lose the lead.

Every submission carries an id that the browser generates once. If the visitor's connection drops and the browser sends the same form again, the connector recognises the id and returns the first submission instead of creating a second lead. Without JavaScript, a fingerprint of the form, its fields and the day plays the same role.

### 3. Push to each CRM

For every CRM listed on the form, in order, the connector does three things:

1. **Find the person by email.** CRMs are matched on email because it is the one field every form has and every CRM indexes.
2. **Create or fill.** A new person is created with every mapped field. An existing person only gets the fields that are still empty, because what a salesperson typed into a record is worth more than what a form says later. You can switch this to `overwrite` or `skip` per CRM. Marketing consent is the exception: it is added when given later and never removed by a form that lacks the tick.
3. **Add a note** holding the whole submission, including fields no mapping covers, so nothing the visitor typed is lost.

Each step saves its progress before moving on. If the connector creates the contact and then the note request times out, the retry starts at the note, with the contact id it already has. That is why a retry never creates a duplicate record or a second note.

### 4. Email the team

The notification goes out last, on purpose, so it can say where the lead landed: "hubspot: created, contact 123" or "dandirock: not yet, will retry". A CRM failure shows up in the same inbox as the lead itself. The email's Reply-To is the visitor, so answering it reaches them directly.

Email can go out over SMTP (ports 465 or 587), Resend, Postmark, or a log for testing.

## What happens when something fails

A failed delivery is retried after 1 minute, then 2, 4, 8 and so on, never more than 6 hours apart, for 8 attempts by default. Every attempt is written to the delivery log, so `crm-connector status` shows exactly where each submission stands.

Two kinds of failure are treated differently. A timeout or a server error is temporary, so it is retried. An HTTP 400 or 422 means the CRM rejected the data itself, and sending the same data again will not change the answer, so the connector stops at once and emails a person with the error and the submission. After fixing the cause, `crm-connector retry <id>` puts it back in the queue.

Submissions are deleted after 30 days by default, because the CRM is the record that lasts and the outbox only needs to hold what is still in flight.

## How it connects to different CRMs

Each CRM has a small adapter in `src/crm/` that knows its API: how to search by email, how to create and update a person, and how to attach a note.

| CRM | Person record | Where the submission goes |
|---|---|---|
| HubSpot | Contact | Note on the contact's timeline |
| Pipedrive | Person, plus organization and a lead in the Leads inbox | Note |
| Salesforce | Open Lead | Completed Task |
| Attio | People record | Note |
| Dandirock, Frappe CRM, ERPNext | Lead (one shared adapter, they use the same API) | Note or Comment |
| Anything else | Signed webhook to Zapier, Make, n8n or your own endpoint | The full JSON payload |

The webhook signs every request, so the receiver can prove it came from your connector: the `X-Relay-Signature` header holds `sha256=` followed by an HMAC-SHA256 of the timestamp and the body, and an `Idempotency-Key` header lets the receiver ignore repeats.

Field names on the form are matched loosely, so `firstname`, `prenom` and `vorname` all become `first_name`, and `company`, `firma` and `entreprise` become `company`. Each adapter maps those standard fields to the CRM's own fields, and a `fields` block in the config can add, change or remove any mapping.

## Why it is built this way

**No AI model anywhere in the path.** Validation, matching, mapping, retries and the email are all fixed rules, so the same submission produces the same result every time and every outcome can be read back from the log. A lead pipeline is the wrong place for a component that is right most of the time.

**No dependencies.** The code uses only what Node 22.5 and Cloudflare Workers already provide: `fetch`, Web Crypto, `node:sqlite` or D1, and raw sockets for SMTP. There is no package to update and nothing to audit beyond these files.

**One config file.** Every form, CRM and email destination is described in `relay.config.json`. Secrets are never written there: a value like `"env:HUBSPOT_TOKEN"` is read from the environment or the Worker's secrets, and `crm-connector check` lists every missing one at once.

## What it does not do

It does not send an autoresponder to the visitor, because a service that emails any address typed into a form can be turned into a spam relay in your name. Add one only behind a CAPTCHA or double opt-in. It does not accept file uploads, which would raise the size limit, the storage question and the malware question together.

## How far it has been tested

There are 16 automated tests that run against simulated HubSpot, Pipedrive, Salesforce, Attio, Frappe and webhook APIs and a fake mail server, plus a smoke test that runs the Worker build inside Cloudflare's local runtime. A live run against a Dandirock instance created a lead, filled it from a second submission without duplicating it, and refused a repeated submission.

The HubSpot, Pipedrive, Salesforce and Attio adapters have so far only been tested against simulations built from each vendor's API documentation. They prove the connector's own logic, not that each vendor accepts the requests. Running `crm-connector test-crm <name>` against a real account settles that in one command, and it is the first thing worth doing before you point a live form at a new CRM.
