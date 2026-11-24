# Mailoop

**make EDM great again**

Mailoop is an open-source design for an AI agent framework for email outreach. A creator partnerships team can describe who it wants to reach, review the evidence for each business contact, and run a campaign from mailboxes its members have connected. Replies return to the teammate who owns the conversation.

**Project status · Design stage.** This repository contains the product specification, architecture, integration contracts, and implementation plan. The first release milestone is a replayable campaign using a simulated mailbox. There is no installable runtime yet.

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
