# 数据、API 与事件契约

## 对象及约束

下表给出第一批迁移必须表达的语义。除 workspace 本身和系统级配置，外键均含 workspace_id，时间字段以 UTC 保存。联系人邮件密文与组织专属 HMAC 分栏；归一化去空白、规范域名，保留 local-part 的提供商语义，不全局剥离加号标签或点。

| 实体 | 关键字段与约束 |
| --- | --- |
| workspace / membership / campaign_role | 成员角色、状态、权限版本；同一组织内 user 唯一，活动角色引用有效成员 |
| mailbox_grant / sender_identity / delegation | provider、provider_account_id、owner、secret_ref、scopes、状态、版本；同一组织内 provider+account 唯一；身份记录 verified From，委托绑定活动、动作和到期时间 |
| model_binding / agent_run / step / tool_invocation | 绑定的主体/预算，run 固定配置及输入摘要；step 保存 checkpoint；run+invocation_key 唯一 |
| campaign / brief_revision / brand_fact | 语言、市场、时区、目的、事实出处与有效期、序列版本；已批准内容引用不可变版本 |
| creator / channel / contact_point / creator_contact / evidence | 渠道平台+稳定 ID 唯一；地址组织内唯一；人和地址多对多；证据含 URL/供应商记录、来源、核验时间、状态 |
| contact_permission / suppression | permission 绑定地址、受众目的、地区、依据、凭证引用、授予/到期/撤销时间；suppression 按组织和联系键唯一，保留原因和生效时间 |
| import_batch / engagement | 研究 run ID+workspace 唯一并保存内容摘要；campaign+creator 唯一。engagement 固定负责人、发件身份、阶段及最后回信 |
| message / revision / approval | 入站与出站关联 engagement；规范线程 ID、provider ID 与 RFC ID 独立；approval 记录审核人、版本/最终输出指纹、时间及有效期 |
| dispatch / attempt / quota_reservation | 一个 engagement 的序列版本+逻辑步骤只允许一个有效投递意图；同一意图可有多次有记录的尝试；预留以 dispatch+额度桶唯一 |
| inbox_cursor / inbox_event / audit_event / report_projection | 游标按邮箱+文件夹/标签；消息以邮箱及稳定服务商标识去重；事件含单调游标、occurred_at、recorded_at 和 schema_version |

冷却在 campaign 以外检查。对同一联系地址以 workspace+contact_key 串行化预留，检查正在排程和最近已受理的首封，跨活动或同经纪地址碰撞时暂停并交给运营。邮件正文使用不可变 revision；删除或更换签名、收件地址、线程或发件身份会使待用批准失效。

## 外部接口（v1 草案）

所有路径以 `/v1` 开头。工作区从已验证的会话或令牌推导，列表使用不透明 cursor。每次受保护操作重新验证成员状态与活动范围。模型推理工具只持本次运行的小范围凭证。OAuth 回调和厂商 webhook 有各自独立的验证路径。

| 方法与路径 | 调用者与输入 | 成功结果 / 关键失败 |
| --- | --- | --- |
| POST /mailbox-connections；GET /oauth/{provider}/callback | 邮箱所有者，provider、用途、活动范围；回调带 state/code | 授权跳转/待核身份；过期、重复回调或身份冲突时不给新委托 |
| POST /mailboxes/{id}/delegations；DELETE /mailboxes/{id}/delegations/{grant} | owner，指定成员/活动、动作、到期时间 | 返回新权限版本；撤权冻结旧版本任务 |
| POST /model-bindings；DELETE /model-bindings/{id} | 绑定所有者，选择 provider、执行位置和授权模式；key 经 TLS 单次提交，本地计划仅登记非秘密元数据 | 返回 binding ID、可用模型、能力和预算类型；撤销后的运行等待授权 |
| POST /runs/{id}/claim-local；POST /runs/{id}/artifacts | 已登录的本地所有者领取指定 run；提交产物携带短期单运行 ticket、步骤版本和摘要 | 单一有效租约；仅可读取获准任务上下文、提交符合 schema 的产物，过期/重复按版本处理 |
| POST /campaigns；POST /campaigns/{id}/runs | 运营，brief 版本、skill、binding、预算、客户端幂等键 | 201 活动或 202 run ID；资源不同组织返回 404 |
| GET /runs/{id}/events；POST /runs/{id}/resume | 运营/限权 agent，游标、checkpoint、授权或预算版本 | SSE 支持 Last-Event-ID；恢复只从待恢复状态进入 |
| POST /campaigns/{id}/imports/preview；POST /campaigns/{id}/imports/apply | research:import，提交研究结果；应用带 previewId、digest、幂等键 | 逐行结果和摘要；同键同内容回放，同键不同内容或预演已过期返回 409 |
| POST /contacts/{id}/permissions；DELETE /contacts/{id}/permissions/{permission} | 授权运营提交或撤回用途、依据类型、证据、地区、有效期 | 保存或撤销证据记录，更新受影响待发项；研究凭证调用返回 403 |
| POST /engagements/{id}/drafts；PATCH /messages/{id}/draft | 活动运营，模型或人工文案、预期 revision；PATCH 带 If-Match | 返回新 revision 和 lint；并发编辑返回 412 |
| POST /campaigns/{id}/approvals | 审核人，明确列出 dispatch 目标、revision 和预期指纹，附幂等键 | 同一批全部校验后写批准和投递意图；任何行失效返回 409 与逐行原因，本批无写入 |
| POST /campaigns/{id}/pause；POST /dispatches/{id}/reconcile | 有权限的运营，原因与预期版本 | 暂停或对账任务；对已受理消息返回可解释状态 |
| POST /webhooks/{provider}；POST /unsubscribe/{token} | provider 验签/校验订阅的通知；经签名的一键退订 | 写入后快速响应；重放不重复派发或退订；GET 不产生退订 |
| GET /inbox；POST /inbox/{id}/actions；GET /reports/campaigns/{id} | 获准成员按活动读、纠正分类/认领/回复草稿、查日期和口径 | 按角色返回字段；报告含 cohort、窗口、时区、数据水位、分子分母及下钻条件 |

动作接口统一返回 `{error: {code, retryable, requestId, affectedIds}}`。401 表示重新认证，403 表示能力不足，409/412 需要先读回差异，422 返回逐字段问题，429 带 Retry-After。未确认投递作为业务状态返回；客户端重放请求不得自行触发第二次外发。

## 消息与事件范例

以下为服务端已写入事件账本的合成示例。消费者凭 eventId 去重。接受投递后才会产生 accepted，硬退信追加独立事件，保留先后两项事实。

```json
{
  "schemaVersion": 1,
  "eventId": "evt_demo_005",
  "cursor": "42",
  "type": "dispatch.accepted",
  "workspaceId": "org_demo",
  "campaignId": "camp_demo",
  "dispatchId": "dispatch_demo_005",
  "mailboxId": "mb_demo_a",
  "occurredAt": "2026-11-20T02:00:04Z",
  "recordedAt": "2026-11-20T02:00:06Z"
}
```

最小事件族为 run.started/step_completed/waiting/completed、import.applied、approval.granted/invalidated、dispatch.scheduled/accepted/unknown/rejected、inbound.matched、reply.classified、suppression.created、engagement.stage_changed、mailbox.revoked。单个聚合使用递增版本作并发检查。回信可能先于受理回执到达，先落入站事实，完成关联后按原发生时间重算投影。导出、删除和重建报表按 workspace 范围执行。

## 测试时必须证明的不变量

同一 run ID 不能因换模型而生成两批写入；同一草稿的双击批准只能产生一条逻辑投递；同一个共享经纪地址不会把不同创作者自动归并。已知被抑制的地址跨成员不可排程。未知提交不可自动重发。入站重复事件只更新一次活动统计。删除成员后旧 token、旧审批或旧 worker 领取记录均不能授权新的交付。 [验收计划](delivery.md)
