# CRM Connector: Product Notes

## The job

A person submits a form on a website. Three things must happen, and none may be lost: the lead lands in the CRM the team works from, the team hears about it within minutes, and the visitor gets an answer at once. Form SaaS tools do this for a monthly fee and lock the CRM choice. Hand-written handlers usually do it inline, so a CRM outage at 2 am drops the lead silently. torke.tech hit that failure on 25 October 2026, when its Worker had no SMTP secrets and every email from the site had been failing without anyone noticing.

## Design decisions

- **Every step is a rule, no model call.** Validation, matching on email, field mapping, retries and the email are all deterministic, so the same submission gives the same result every time and every outcome can be read back from the delivery log.
- **Store first, deliver after.** The outbox row is the commit point. The visitor's answer depends only on that write, and delivery runs after it with retries.
- **Email after the CRMs.** The notification reports where the lead landed, so a person sees a CRM failure in the same email as the lead.
- **Fill, never overwrite, by default.** What a salesperson typed on a record is worth more than what a form says later.
- **Resumable adapters.** Each adapter saves its progress per step (record id, note id), so a retry never duplicates a record or a note.
- **One adapter per API family.** Dandirock, Frappe CRM and ERPNext share the Frappe REST API, so they are one adapter with presets. The signed webhook covers every CRM without a native adapter.

## Not built, on purpose

- **An autoresponder to the visitor.** A relay that emails any address typed into a form can be used to send spam in your name. Add it only with a CAPTCHA or double opt-in in front.
- **File uploads.** They raise the body limit, the storage question and the malware question together.

## Status, 26 October 2026

Version 0.1.0. 16 tests pass on Node, the Worker smoke test passes in wrangler 4.92.0, and a live run against the local Dandirock created, then filled, a lead with two notes and no duplicate. The HubSpot, Pipedrive, Salesforce and Attio adapters have only been tested against simulations built from their documented request shapes.
