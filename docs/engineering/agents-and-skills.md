# Agent、模型授权与技能协议

## 一次运行

用户发起活动任务后，runtime 将描述编译为可编辑的 brief，解析硬条件、偏好、语言、作品时间范围、公开来源和预算。操作员确认研究范围后，runtime 按需加载技能、选择工具、执行一个步骤、校验结果、持久化产物及事件，再决定下一步。每个 run 固定 brief 版本、skill 版本、工具集合、模型绑定、费用上限、步数、截止时间和操作者权限。

工具分为只读检索、可回滚的工作区写入和外部交付。模型可提出撰写和排程请求；领域层负责批准，投递由持有邮箱委托的 worker 完成。每轮工具调用记录 invocation ID、输入摘要、权限决定、结果引用及计费信息。恢复先读取已有结果。消耗达到预算、凭据到期或证据不足时，运行分别进入等待预算、等待授权或人工核查。

## 模型与 coding plan 接入

| 模式 | 用户经历 | 实现和可验收范围 |
| --- | --- | --- |
| Claude / GPT / Gemini API key（M1–M3） | 选择供应商、填写自己的 key、探测可用模型、指定允许的活动和额度 | Claude Messages、OpenAI Responses、Gemini generateContent 分别适配；运行时统一为生成、结构化结果、工具请求、用量和终止原因。认证、计费、能力错误分别显示。 [Claude](https://platform.claude.com/docs/en/api/overview) · [OpenAI](https://developers.openai.com/api/reference/responses/overview) · [Gemini](https://ai.google.dev/gemini-api/docs/api-key) |
| ChatGPT 计划绑定（M3 本地预览） | 用户在本机 Mailoop 中选择使用现有计划，经官方浏览器授权，查看账户、授权范围、可用模型和撤销入口 | 对符合条件的开源本地客户端，使用官方 Sign in with ChatGPT。稳定 host ID、一次性 state/nonce、PKCE、loopback 回调、校验 ID token 与授予 scopes，凭据留在用户主机。发送 store=false、stream=true 的兼容请求，持久化必要会话状态。共享托管产品另走厂商流程。 [接入范围](https://developers.openai.com/siwc/token-sharing-open-source) · [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) |
| Claude Code 原生工作流（M1 起） | 有订阅的成员自行在官方 Claude Code 中打开 Mailoop 研究 skill，生成候选文件，再用独立的 Mailoop 研究身份预演导入 | 宿主持有自己的订阅和用户会话，Mailoop 接收结构化产物。组织后台使用 Claude API key；Anthropic 对第三方代用 Claude.ai 计划凭据有明确限制。 [Claude Code 使用条款说明](https://code.claude.com/docs/en/legal-and-compliance) · [Skills](https://code.claude.com/docs/en/skills) |
| Gemini CLI 原生工作流（M1 起） | 用户在官方 CLI 的可用账户/计划下运行研究说明，审阅后导入相同格式 | 第三方 runtime 走 Gemini API 凭据；Google 对复用 Gemini CLI OAuth 直连后台有限制。原生宿主与 Mailoop 分别管理自己的权限。 [Google 说明](https://geminicli.com/docs/resources/tos-privacy/) |

每个 model binding 声明 owner、workspace、允许的技能、运行位置、计费类型、模型 ID、可用能力和 secretRef。组织密钥可按活动授予；个人计划只能在其用户批准的本地会话中执行，连接断开时任务等待该成员。设计为本地客户端凭用户会话和单次 run ticket 拉取任务、提交结果，API 核对 run、成员和 workspace；计划令牌不上传。模型不可用时保留草稿与 checkpoint，用户明确选择新授权和预算才切换。API 费用、搜索费、订阅用量分别显示；提供商没有返回的费用标为未知。

## Skill 格式与执行权

每个 skill 目录用 `SKILL.md` 放 name、description 和操作说明，可带 schemas 与少量示例。安装时将版本摘要、输入输出 schema、必需工具、最大成本和允许副作用登记到 Mailoop registry。模型只能使用「skill 声明 ∩ 本次任务 ∩ 当前角色 ∩ 组织策略」的工具集合。MVP 提供内置、固定版本的技能，更新后进行回归评估；外部宿主可以只读取说明文件。 [Agent Skills 规范](https://agentskills.io/specification)

| 内置 skill | 主要输入 → 产物 | 工具与停止条件 |
| --- | --- | --- |
| audience-brief | 自然语言、活动事实 → 受众查询、必选/偏好、排除条件 | 只读活动；关键条件矛盾时请求运营选择 |
| discover-creators | 查询、地区、语言、数量和来源预算 → channel、作品与匹配理由 | 授权搜索 API、平台准许的接口、公共页面或用户交付清单；达到上限返回部分结果 |
| verify-contacts | 候选及来源页面 → 公开商务联系点、证明链接、核验时间或缺失原因 | 程序从原页面核对地址与「商务合作」语境。无明确地址返回空；供应商记录另列 provider/recordRef 和人工复核要求 |
| compose-outreach | 有效事实、核验过的作品、语言与身份 → 首封主题、正文、来源引用及 lint 结果 | 无法支持的报价、经历、合作承诺均退回；可生成只供审阅的草稿 |
| schedule-outreach | 已批准 revision、固定发件人、活动时窗 → 发送意图与候选时段 | 只能请求领域层入队；缺少批准、委托或发送依据时返回逐项原因 |
| triage-replies / compose-followup | 关联线程、最新入站、已批准历史 → 分类、建议动作、同线程草稿 | 先暂停活动跟进；强退订信号直接走抑制。低置信分类待核；新回复、过期事实或未知投递禁止自动跟进 |
| campaign-report | 活动、队列区间、数据水位 → 带分子分母和明细引用的摘要 | 只读聚合工具，模型可解释异动；数值由查询计算 |

## 联系人研究契约

首个真实搜索适配器拟接 Brave Web Search API。组织提供搜索 key，步骤输入为 query、地区、语言、页数及消耗上限，输出为结果 URL、标题和检索时间。随后读取获准访问的创作者页面来核实作品与合作入口。提供商计划决定搜索结果可存储的范围。没有搜索授权时仍可从运营提供的 URL 清单开始研究，界面注明覆盖范围。 [Brave Search API](https://brave.com/search/api/)

1. 硬条件由确定性过滤器核对；模型提议查询词和匹配理由。来源 adapter 保存原 URL、获取时间、来源类型和最小必要的佐证摘录。将网页内容作为数据传给模型。
2. 按平台稳定账号 ID 和规范主页去重。邮箱同时出现于多个创作者不自动合并人，可能是经纪机构。没有作品发布日期时标为待核。没有公开商务地址可保留候选，不推测地址。
3. 导入先验证输入 schema，再由服务端按允许来源重新取证或交人工核对。公开商务联系点、供应商记录、组织已获同意分别管理；研究身份不能颁发发送许可。每行返回 created、matched、duplicate、needs_evidence、suppressed 等决定和理由。 [合成样例](../examples/research-result.json) · [JSON Schema](../examples/research-result.schema.json)
4. 运营审查预演，将 preview ID 与输入摘要一同提交。申请写入时重新检查库内最新重复和抑制情况，发生变化则返回差异供复核。分页、调用上限、失败源和未覆盖的平台进入研究摘要。

模型适配器验收使用同一组多语种合成 brief、页面和回信，固定预期的结构、证据命中和禁止动作，并记录 token、费用和耗时。CI 使用录制的脱敏响应，发布前用团队自己的试验账户逐一检验实时适配器。无授权、配额耗尽、结构化输出失败都必须有可恢复的状态和可读原因。
