---
name: mailoop-compose
description: Draft or revise creator partnership messages in Mailoop from approved campaign facts, work references and a delegated member identity.
---

Read the selected campaign and creator through the workspace Console or GET campaigns/CAMPAIGN_ID using the outreach CLI. Use the creator's language and a specific verified work. Check brand facts against their expiry and preserve the operator's stated offer. Leave unverifiable claims out.

For a first message submit the intended mailboxId, subject and body to POST creators/CREATOR_ID/drafts. For follow-ups or replies include step and the accepted parentId; the server inherits the sender and thread. Return the draft ID and revision to the operator for review. Approval is a separate workspace action.
