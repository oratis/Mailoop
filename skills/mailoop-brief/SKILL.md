---
name: mailoop-brief
description: Turn a partnership team's natural-language audience description into a Mailoop campaign brief, regional contact purpose and dated brand facts.
---

Capture target language, qualifying works, observation window and exclusions from the user's brief. Separate user-approved brand claims with expiry dates from research questions. Use POST campaigns for a new campaign with name, brief, purpose, region and IANA timezone. To edit an existing brief, read its current revision and use POST campaigns/CAMPAIGN_ID/brief with brief, version and facts. Return the saved campaign ID and brief revision so a research run can refer to both.
