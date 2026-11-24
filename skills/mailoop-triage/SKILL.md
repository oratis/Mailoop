---
name: mailoop-triage
description: Triage campaign-linked replies and prepare thread replies in Mailoop when an operator asks to process the inbox or review interested creators.
---

Read the selected campaign and its inbox with the operator's workspace token. Use the creator's linked letter, sender identity and inbound message ID to keep attribution intact. Distinguish quotes, interest, declines, automated responses and opt-outs. Describe ambiguous classifications to the operator. Apply their selection with POST inbox/INBOUND_ID and the chosen kind. A recorded opt-out suppresses the address across the workspace.

For a requested reply, prepare a draft with POST creators/CREATOR_ID/drafts using step reply, the accepted parentId, subject and body. Record the draft revision in the result.
