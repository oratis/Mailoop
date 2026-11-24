# 组织邮箱与 connector 契约

## 一个成员如何授权

1. 成员在当前 workspace 选服务商、用途与活动范围。服务端创建一次性连接会话，绑定 workspace/member、回调地址、有效期和 state；支持 PKCE 的流程同时校验 verifier。
2. OAuth 回调先验证会话，再向服务商查询实际用户、邮箱及可用 From 身份。保存稳定的 provider account ID，展示已验证身份供成员确认；地址改名时能找到原授权。同邮箱在本 workspace 已连接时引导原所有者重联。
3. 保存 grant 和密钥引用；以最小 scope 完成身份及能力探测。成员可以只授予草稿或发送，读取相关会话需要单独同意。组织管理员分配活动也只能使用 grant 内被批准的能力。
4. 委托记录列明所有者、允许的运营/活动、可用身份、截止时间、日额度和权限版本。本人撤权、成员离职或刷新失败时立即阻止新投递，冻结待发，解绑订阅并处理提供商端撤销。回调只能落在该 grant 的 workspace。再次授权须核对同一账号和身份。

## 支持矩阵（开发目标）

| 适配器 | 身份、投递和回执 | 收件同步、降级与验收 |
| --- | --- | --- |
| 模拟邮箱 · M0 | 固定合成身份，按脚本返回受理、拒绝、超时或受理后断线 | 生成重复、乱序和丢失通知，支持断点对账；离线 CI 的基准 |
| 飞书 Mail · M2 | 成员 OAuth、核验发件身份、建草稿、提交草稿，保存厂商消息和线程引用 | 新邮件通知配合分页补拉；租户能力或应用权限只允许草稿时展示「仅草稿」。使用独立测试租户核验撤权与已发送文件夹对账。 [发送接口](https://open.feishu.cn/document/server-docs/mail-v1/user_mailbox-message/send) |
| Gmail / Workspace · M3 | 成员 OAuth；发信用 gmail.send，服务商草稿需要相应 compose 能力；核对 From 与已授权别名 | 接收及对账需另获合适读取权限。history 游标失效时有界回补；缺读权限时标示「仅发送」，关闭自动跟进。公用 OAuth 应用按 scope 完成适用的验证和安全评估。 [Scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) · [同步](https://developers.google.com/workspace/gmail/api/guides/sync) |
| Microsoft 365 / Outlook · M4 | Microsoft Graph delegated Mail.Send；创建/编辑云端草稿另需相应读写权限。sendMail 的 202 只记受理 | 按文件夹保存 deltaLink，使用稳定 ID 策略，结合 Internet Message-ID 对账。先做本人邮箱，共享邮箱额外校验委派和 Send As。 [sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0) · [Delta](https://learn.microsoft.com/en-us/graph/delta-query-messages) · [稳定 ID](https://learn.microsoft.com/en-us/graph/outlook-immutable-id) |
| 通用 SMTP + IMAP · M4 | 含 TLS 验证的 SMTP submission 与支持的 OAuth/应用专用凭据；服务端确认受理后记 accepted。对自定义主机执行部署侧网络策略 | SMTP-only 明示无自动回信数据；IMAP 按 mailbox、UIDVALIDITY、UID 保存游标，重置时有界回补。自定义域、地区邮局按各服务商能力单独验证。 [IMAP 标准](https://www.rfc-editor.org/rfc/rfc9051.html) |

接入通用接口时，适配器声明 capabilities，例如 send、providerDraft、replySync、sentLookup、verifiedAlias、oneClickHeaders。上游头部会否保留、是否 DKIM 签名须用测试收件箱验收。需要某能力的活动只能使用该能力已验证的身份。Gmail 商业发送要求可核验同意；提供商的商用政策、组织许可、地区规则都参与发送资格裁决。 [Google 数据政策](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) · [发件人指南](https://support.google.com/a/answer/81126)

## Adapter 消息与结果

| 操作 | 输入 | 输出及责任 |
| --- | --- | --- |
| authorize / complete / revoke | 连接会话或 grant 引用 | 已核验身份、grant 版本、授权能力和有效期；敏感值进入 vault |
| probe / refresh | grant、期望版本 | 返回可用/受限/需重新授权与原因。刷新串行化，使用 CAS 保存轮换后的 refresh token |
| createDraft / submit | dispatch ID、冻结的 MIME、已核验 From、可选 provider draft ID | accepted(receipt)、definitive_rejection(reason) 或 unknown(attemptRef)。令牌过期和限流只有明确未受理才可重试 |
| reconcile | attemptRef、provider draft ID、RFC Message-ID、邮箱范围与时间界限 | found / confirmed_not_submitted / inconclusive；搜索暂未找到仍是 inconclusive |
| sync / normalize | grant、游标或推送提示 | 规范化信封、线程与交付事件、新游标；保留 provider 和 RFC 两类标识 |

## 路由、频控与会话

- 每个 engagement 首选活动指派成员有权使用的邮箱。首封记录固定的 mailbox、identity、owner 和委托版本，后续回复与跟进沿用。多个候选时先按显式分配，再按该身份可用时窗和容量排序；发件人写入待批准内容。服务商限流只会推迟任务。
- 发送前同时校验组织与账号额度、域策略、收件人当地时间及周末规则、跨活动冷却、仍有效的发送依据、活动状态与最新回复。时区使用 IANA 名称，夏令时按实际投递日处理；未知时区按活动后备值提示运营。配额按明确时区的桶预留，未知结果保留占用直到对账。
- 线程先按该 workspace + 邮箱的 provider thread/message 匹配，再按 References/In-Reply-To 与外发记录匹配。共享经纪地址、同名主题、转发或抄送造成多候选时进入所有者待核，不自动向新地址回复。分类前先把已匹配的人类来信挂起待跟进；自动回复在确认后可按返岗日重新排程。
- 退订端点接受带签名、不含明文地址的 token，幂等处理。营销列表配置产生 HTTPS List-Unsubscribe 和 List-Unsubscribe-Post，只有有效 POST 才一键退订；GET 展示确认页，避免链接预读误触。同步处理回复退订、投诉和硬退信。域认证、可见退订入口、提供商对签名和头部的支持纳入预检。 [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058) · [Gmail 指南](https://support.google.com/a/answer/81126)

## 账号异常的操作结果

| 事件 | 系统行为 | 恢复条件 |
| --- | --- | --- |
| OAuth scope 不足 / 被撤销 | 降级能力、冻结相关待发、向所有者提示重联 | 相同成员重联并通过探测；已变更的批准另行复核 |
| 429 / 明确临时失败 | 遵守 Retry-After，有限次指数退避；超过截止时间转 held | 在原邮箱、原批准和策略仍有效时继续 |
| 请求可能已到达上游 | 提交结果设 unknown，生成对账任务，UI 展示原尝试 | 确认已发送则采纳回执；有确证未交付才允许重排 |
| 同步落后、无法读取或重建游标 | UI 显示回复覆盖不完整，自动跟进暂停 | 消费追平且水位满足活动要求 |
| 所有者离职 | 禁用 grant、取消未交付任务、可移交活动及组织已保存的相关上下文 | 新所有者重新授权；更换发件身份重新审批 |
