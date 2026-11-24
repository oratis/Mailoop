# 参考项目评审

## 创作者运营控制台

下表来自对一套现有 KOL 控制台的页面、服务端处理器、调研导入契约及报表代码的静态走查。它区分已见行为与 Mailoop 的实现决定。功能观察不代表生产效果测量。

| 已见工作流 | 决定保留的行为 | Mailoop 的改造和排期 |
| --- | --- | --- |
| 活动 brief、受众、事实及有效期、序列、看板 | 写信时能回到同一版合作条件，过期事实阻止审批 | 将品牌事实和流程版本归 workspace；M1–M2 |
| 外部研究 agent 读 brief、查重、预演和分批导入 | 相同研究运行可以重放；每行有接受、合并或跳过原因；供应商联系方式单独审核 | 增加可替换的检索源、证据与发送资格两次判断；M1 |
| 创作者档案、渠道、近期作品、合作进度及已回复关系池 | 一位创作者可有多个账号、联系点和经纪人；合作历史跨活动可见 | 将人、联系地址、活动关系分表；归属在组织内共享，热池在 M3 |
| 生成首封、跟进和同线程回复；事实与正文 lint；发件箱批审 | 查看个性化依据、逐条退回，批准后可追溯版本 | 统一成模型无关的 skill 输入输出；签名、事实、正文或发件人变化使批准失效；M1–M2 |
| 成员飞书邮箱授权、草稿模式、发送窗口、邮箱及团队预算 | 成员级撤权、核验身份、收到回复后停止跟进；交付结果未知时查已发送 | 首批抽象为飞书与 Gmail 两个独立 adapter；每组织另建权限与额度，M2–M3 |
| 收件、线程关联、未匹配队列、来信分类、人工纠错 | 团队能看见谁该处理报价、婉拒、退订和自动回复 | 收件箱只暴露有关联或已显式共享的邮件；模糊匹配只给候选；M2–M3 |
| 首页待办、当日配额、活动流、日报、投放归因 | 可从每个异常或统计回到待处理对象，日报可重算 | 建可重放事件账本。M3 提供活动漏斗、模板与邮箱表现，M4 增加业务归因 |
| 订单、内容交付、发布链接、归因码、结算 | 保留合作的最终结果才能评估外联质量 | 首期人工记「达成合作」及外部引用；M4 用事件接入内容/转化。打款、税务、支付供应商留给外部业务系统 |

参考实现中，飞书邮件是可以沿 OAuth、草稿和投递代码追到的适配器。Gmail、Graph 以及通用邮局均为新设计。参考系统接收外部 agent 的研究产物，也有内部撰写和分类；Mailoop 将“根据描述找到候选并取得联系证据”做成一等运行，由同一活动记录进度和成本。

## Agent 与邮件系统

| 参考 | 实际查看的接口或组件 | 对 Mailoop 的决定 |
| --- | --- | --- |
| OpenAI Codex，Apache-2.0 | App Server 将 thread、turn、事件和请求批准暴露给客户端，支持断线后恢复线程。 | Console 与 CLI 共用 run/event API；重连从事件游标恢复，批准绑定持久化副作用。 [固定提交的协议说明](https://github.com/openai/codex/blob/53fe98bdc22c19b9520b0d033c2b0a1b0be62bcb/codex-rs/app-server/README.md) |
| Claude Code | Skills 按描述发现、按需加载说明；公开发行仓库的许可保留权利并引用商业条款。 | 借鉴技能发现、人审和本地用户体验。Mailoop 独立编写实现；Claude Code 作为用户可自行选用的宿主。 [Skills](https://code.claude.com/docs/en/skills) · [仓库许可](https://github.com/anthropics/claude-code/blob/112541d8e85f32512d6169612ab4af30935d96b2/LICENSE.md) |
| Gemini CLI，Apache-2.0 | core 中的 turn、content generator 与工具分离；工具目录含技能激活、计划和确认。 | 将模型生成、技能装载、工具调用拆开，测试时可替换模型并验证动作。 [Core](https://github.com/google-gemini/gemini-cli/tree/03862c4164844c6cf8063b4cc48546ec1609cf2e/packages/core/src/core) · [Tools](https://github.com/google-gemini/gemini-cli/tree/03862c4164844c6cf8063b4cc48546ec1609cf2e/packages/core/src/tools) |
| Agent Skills 规范 | 用 SKILL.md 的 name、description 和正文表达技能，相关资源可按需读取。 | 保持可携带的说明文件；JSON 输入输出、工具许可和版本摘要由 Mailoop 单独登记。 [规范](https://agentskills.io/specification) |
| listmonk，AGPLv3 | manager 的队列、消息和管道与 bounce 模块分工；活动报告能展示退信。 | 抽取「受理」「退信」「回复」作为不同事件，独立实现队列和抑制逻辑。 [Manager](https://github.com/knadh/listmonk/tree/47a24dfe8a889b0c7fe8730b0bb7ac24ab571e87/internal/manager) · [Bounce](https://github.com/knadh/listmonk/tree/47a24dfe8a889b0c7fe8730b0bb7ac24ab571e87/internal/bounce) |

**架构取舍。** 直接在一个 coding agent 上安装邮箱工具，能很快演示写信，但很难让不同成员的权限、重试与活动报表共用一个事实来源。Mailoop 把可恢复的活动和邮件状态放在服务端，允许原生 coding agent 通过受限的导入接口参与同一条流程。 [系统架构](../engineering/architecture.md)
