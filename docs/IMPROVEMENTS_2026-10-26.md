# Improvements, 26 October 2026

- First version: core, six adapters (HubSpot, Pipedrive, Salesforce, Attio, Frappe family, webhook), SMTP, Resend and Postmark email, SQLite and D1 outbox, Node and Workers runtimes, CLI, embed script.
- Live run against the local Dandirock on :8050 through a dedicated API user, lead-relay@dandirock.localhost.

Next, in order of value:
1. Run `test-crm` against a real HubSpot, Pipedrive, Salesforce and Attio account, since only simulations cover them today.
2. Move the torke.tech forms onto the relay, or keep its D1 pull into Dandirock and use the relay for new sites only.
3. A Zoho and a Close adapter, if a client asks for one; the webhook covers both meanwhile.
