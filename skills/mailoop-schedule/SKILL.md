---
name: mailoop-schedule
description: Review and schedule already drafted Mailoop campaign letters when a workspace reviewer asks to approve a send or inspect the outbox.
---

Read the selected campaign, exact letter revisions, From identities, recipients, subjects and bodies. Explain blocked entries and the requested sending window in the campaign timezone. Use POST campaigns/CAMPAIGN_ID/approve with an items array containing id, revision and the requested dueAt for each expressly approved letter. If the server reports a changed revision, retrieve the new draft for review. Report held and uncertain dispatches separately and inspect campaign events for reconciliation.
