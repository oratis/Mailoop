# Mailoop

**make EDM great again**

Mailoop is a self-hosted, open-source AI agent framework for email outreach. A creator partnerships team can describe who it wants to reach, review the evidence for each business contact, and run a campaign from mailboxes its members have connected. Replies return to the teammate who owns the conversation.

**Project status · Developer preview.** The workspace includes three model providers, local coding-agent skills, member-owned mailbox connectors, revision approval, a reconciled outbox, an inbox and cohort reports. The provider matrix records the available tests and external release gates. [Operator guide](docs/operations/self-host.md)

## Run a persistent workspace

With Docker Compose, generate a private environment file and start PostgreSQL, the API and the worker.

```sh
umask 077
{
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "MAILOOP_DB_PASSWORD=$(openssl rand -hex 24)"
  echo "MAILOOP_MASTER_KEY=$(openssl rand -base64 32)"
} > .env
docker compose up -d --build
docker compose run --rm migrate node --import tsx scripts/manage.ts workspace "Partnerships"
```

Open the private workspace link printed by the last command. Create a campaign, invite a reviewer and connect a mailbox under **Connections**. Each mailbox owner delegates access to specific campaigns. Use a simulated sender ending in `.example` for a local walkthrough. External sending requires an explicitly enabled deployment. [Configuration and recovery](docs/operations/self-host.md)

## Run the prototype

Use Node.js 22.12+ and npm under a regular user account. Installation downloads a platform-specific PostgreSQL binary. Each run starts a temporary database and a loopback HTTP server. Stopping the demo discards its data.

```sh
npm ci
npm run demo
```

Open the **Coffee Studio** workspace URL printed in the terminal. Review the evidence, sender, recipient, and Japanese draft, then select **Approve simulated send**. Follow the accepted receipt and reply in **Activity**. Open the separate **Field Notes** workspace link to try the same flow in an empty organization. Both links grant local reviewer access for this run.

To exercise recovery, start with `npm run demo -- --lose-receipt`. The simulated provider accepts the first send and drops the acknowledgement. The worker reconciles it using the original receipt. The activity history records the interruption.

For the CLI, set `MAILOOP_URL` to the printed local origin and `MAILOOP_TOKEN` to the token from your own workspace URL. Create a sample and copy its returned `id` and `revision` into the shell variables `CAMPAIGN_ID` and `REVISION`.

```sh
npm run cli -- list
npm run cli -- create "Coffee follow-up"
npm run cli -- show "$CAMPAIGN_ID"
npm run cli -- approve "$CAMPAIGN_ID" "$REVISION"
npm run cli -- events "$CAMPAIGN_ID" 0
```

Use the sequence number of the last event in place of `0` to resume. `npm run build` type-checks the project and bundles the Console. `npm test` starts a separate PostgreSQL cluster for API, worker, isolation, and CLI integration tests.

## A campaign in practice

> Find Japanese-speaking creators who published a home coffee tutorial in the last 90 days. Show where each creator invites partnership inquiries. Draft in Japanese and let our partnerships team review before sending.

1. A research skill turns the brief into search criteria. Each candidate carries a channel, a qualifying work, and a source for any contact address. Missing evidence goes back to the researcher.
2. An operator reviews the shortlist, the basis for contacting each recipient, and drafts grounded in approved campaign facts. A workspace can use its own model keys. Supported coding plans have provider-specific paths.
3. A reviewer approves the exact message and sender. The delivery worker checks mailbox permissions, recipient eligibility, and capacity before handing off each message. A reply stops the pending sequence.
4. The console links each outcome to its source campaign, mailbox, and owner. The team can see who needs a reply and how many conversations led to a partnership.

## Read the design

The design documents are in Simplified Chinese. Start with the product walkthrough or use the index to find a specific contract.

| 产品与调研 | 开发与验收 |
| --- | --- |
| [文档导航](docs/README.md) | [系统架构](docs/engineering/architecture.md) |
| [产品方案与首版范围](docs/product/product.md) | [Agent、模型与 skills](docs/engineering/agents-and-skills.md) |
| [市场调研与定位](docs/research/market.md) | [成员邮箱与 connectors](docs/engineering/connectors.md) |
| [参考项目与能力映射](docs/research/reference-review.md) | [数据、API 与事件契约](docs/engineering/contracts.md) |
| [Console 与指标口径](docs/product/console.md) | [开发里程碑与验收](docs/engineering/delivery.md) |

Contributions to the design are welcome through GitHub issues and pull requests. Use synthetic examples for contacts, email content, and mailbox events. [MIT License](LICENSE)
