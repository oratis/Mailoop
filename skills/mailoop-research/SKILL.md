---
name: mailoop-research
description: Research creator partnerships for a Mailoop campaign and submit a source-backed contact artifact from the user's own coding-agent session.
---

Use the campaign's audience, language, dates and permitted public sources. With a local-artifact model binding, start a research run in the Console. Claim that run through the Mailoop CLI using the workspace's own access token. The claim returns the exact brief revision, JSON Schema and a short-lived ticket.

Query public creator pages or sources explicitly provided for this campaign. Verify the specific work, publication date and the context in which each business contact was published. For a missing address, return an empty contacts array and missingReason. Use a licensed vendor record only when the operator supplied that source and the record reference. Keep contacts for different creators separate, including when they share an agency.

Build the artifact against the returned schema. Submit it with the original run ID, brief revision and ticket using action `submit`. Provide the resulting preview ID and row counts. The operator can review and apply the preview in the Console. Keep tokens, source documents and real addresses out of public commits and issue comments.

From a Mailoop checkout, the CLI accepts `npm run cli -- outreach POST runs/RUN_ID request.json`. For a claim, request.json contains `{"action":"claim"}`. For submission, it contains `{"action":"submit","ticket":"…","artifact":{…}}`. Store both request files in a private temporary directory; remove them after the preview succeeds.
