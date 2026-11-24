# 自托管、连接与验收

持久化部署使用 PostgreSQL 18、独立 Web 服务和 worker。Docker Compose 仅将 8080 端口绑定到本机。运行 README 中的安装命令后，保存数据库口令、主加密密钥和管理员的私有链接。将真实服务置于 HTTPS 反向代理后，并在所有进程上配置相同的 MAILOOP_PUBLIC_URL。活动日志和 CLI 使用同一套 API。 [安装](../../README.md#run-a-persistent-workspace) · [配置项](../../.env.example)

## 第一次运行

1. 管理员创建活动，填写受众、用途、地区、时区和品牌事实。在 Connections 邀请成员并私下交付其访问链接。给成员授予活动访问权。
2. 每个成员添加自己的模型绑定和邮箱。成员可以将邮箱委托给一个或多个活动并设置期限。组织、活动和邮箱的额度取最小余量。创建活动的 API 接受 cap、windowStart 和 windowEnd。时间窗口在活动时区解释，额度使用滚动 24 小时。
3. 从 Research 启动研究，选择模型、最大外部请求次数和来源，也可导入符合 v1 schema 的 JSON。示例的 briefRevision 需要换成当前版本。逐行预演并应用后，核对所引网页及获取联系许可的凭据和有效期。公开的商务地址与目的和地区所需的发送依据分别记录。
4. 从创作者记录起草邮件，选择一个已获委托的邮箱。审核员查看署名、正文、收件人和修订号后批准。worker 重新核对活动、身份、收件资格、限额与抑制状态。结果未知的投递先查提供商回执。只有模拟邮箱可使用 simulate 接口注入回信。
5. 从 Inbox 处理真实或模拟回信。Report 显示首封受理队列的 14 天指标、事件发生日统计和脱敏导出。日报使用活动时区。成本通过业务 outcome 接口归集，保留原币种。

## 模型和研究

| 方式 | 配置与行为 | 验证 |
| --- | --- | --- |
| OpenAI、Anthropic、Gemini API | Connections 输入自己有权使用的模型 ID 和 API key。服务端按 workspace 加密存储，用于研究和写稿 | 三种适配器分别跑过公开合成目录、模型提取、来源复核和导入预演 |
| Brave Search | 配置 BRAVE_SEARCH_API_KEY，worker 检索并独立抓取有界的公开 HTTPS 页面 | 需租户提供搜索账户 |
| OpenAI Web Search | 可单独配置 MAILOOP_SEARCH_OPENAI_KEY、MAILOOP_SEARCH_MODEL。Brave 优先。一次研究搜索最多发起一个工具调用 | 实际检索返回 3 条来源，均完成独立读取。[Web Search](https://developers.openai.com/api/docs/guides/tools-web-search/) |
| 用户提供来源 | 传入 1–12 个公开 HTTPS URL。预算扣除模型调用；研究检查点保留已取得的来源 | 合成目录和引用纠错回归测试 |
| Claude Code、Gemini CLI、Codex | 使用 local-artifact 绑定及仓库 skills，在成员自己的已授权会话中执行。服务器接收短期 ticket 和 schema 产物 | claim、重复提交、撤权、导入预演均有自动化测试 |
| 本地 ChatGPT 计划预览 | 在受支持账户本机运行 npm run plan -- login，再运行 models。run 接受 RUN_ID、模型和公开来源 URL。logout 移除本地 profile。授权文件保存在用户目录 .local/share/mailoop | 已实现动态客户端、PKCE、OIDC 校验和流解析。实际计划资格及用户授权需账户本人验证。[官方接入说明](https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md) |

复现实测可设置 MAILOOP_TEST_MODEL_KEY 后执行下列命令。选择对应的供应商和获准使用的模型。脚本使用临时数据库、执行一次付费模型提取并断言两个候选、一条可回查的联系证据和一个缺失原因。

```sh
node --import tsx scripts/check-research.ts PROVIDER MODEL PUBLIC_URL_OF_EXAMPLE_JSON
```

## 成员邮箱

OAuth 回调统一为公开服务地址加 /oauth/PROVIDER/callback，分别登记到相应厂商的应用配置。环境变量前缀见 .env.example。邮箱 owner 可以撤销活动委托、断开连接并重新授权。开启实发需在 Web 和 worker 配置 MAILOOP_SEND_ENABLED=true，验证退订 URL 在公网可达，并以组织自有测试邮箱核对邮件头、接收和回复。默认外发开关关闭，已开始的投递继续对账。

| PROVIDER | 授权、提交和收信 | 目前验收 |
| --- | --- | --- |
| gmail | Google OAuth，openid、email、gmail.send、gmail.readonly；提交原始 MIME、按 RFC ID 查已发、按 thread 取相关回信 | OAuth、令牌续期和发送合同测试。组织的 OAuth 同意和所需 Google 验证仍须实际完成 |
| feishu | 飞书用户授权、发信身份核对、云草稿、草稿发送、按时间窗口分页查询收件、已发回查；自动发送关闭时进入人工处理 | 授权、草稿能力降级、分页和回信归属合同测试。飞书原生 API 实收实回待测试租户验证 |
| graph | Microsoft 身份平台，offline_access、User.Read、Mail.Read、Mail.Send；Graph MIME sendMail、按 conversationId 读回信 | 合同测试。202 记录服务商受理，实际送达另需证据 |
| smtp | TLS 465 SMTP 和 TLS 993 IMAP。管理员在 MAILOOP_MAIL_HOSTS 逐个列出允许的主机，成员用邮箱应用密码授权。Sent 文件夹可见时按 Message-ID 对账 | 飞书邮箱通过真实 SMTP 验证和 IMAP 登录。客户邮箱需单独验证收发和 Sent 归档能力 |
| nylas | Nylas v3 hosted OAuth，配置客户端 ID、secret 和区域 us 或 eu。通过 MIME 发信并按线程检索回复 | 合同测试。需部署方自己的 Nylas 账户、实际 grant 和租户验收 |
| simulated | 本地确定性邮箱、丢失受理回包、收件回放 | 连续集成覆盖并发审批、重复事件、未知投递和隔离 |

允许可信部署模块通过 MAILOOP_CONNECTOR_MODULES 注册 ext- 前缀的邮箱类型。模块默认导出 MailboxExtension，负责认证、提交原始 MIME、按 RFC 标识对账并读取关联回复。模块随服务部署，拥有进程权限。新增的 skill 以 skills/NAME/SKILL.md 发布，GET /v1/outreach/skills 提供安装清单。 [Connector 接口](../../packages/connectors/sdk.ts) · [Skills](../../skills)

## API、事件和业务回传

设置 MAILOOP_URL 和成员自己的 MAILOOP_TOKEN 后，使用 npm run cli -- outreach METHOD PATH [请求文件]。CLI 的 PATH 相对于 /v1/outreach/。GET campaigns/ID 返回当前角色可以查看的数据。POST creators/ID/outcome 接受 source、externalId、kind、occurredAt，以及可选的 amount、currency。相同来源和外部 ID 的重复回调幂等，不一致的重放返回 409。GET campaigns/ID/report 支持 from、to、mailbox、owner、template、region。GET campaigns/ID/stream 或 runs/ID/stream 接受 Bearer 和 Last-Event-ID。

可信邮件网关可由邮箱 owner 使用 POST mailboxes/ID/bridge 获取专属地址和签名密钥。POST 原始 JSON 附带 X-Mailoop-Timestamp（Unix 秒）和 X-Mailoop-Signature，即 HMAC-SHA256(secret, timestamp + "." + 原始正文) 的十六进制值。载荷包含 eventId、kind、address（原收件地址）、at、references 和可选 text。kind 可取 reply、auto_reply、opt_out、soft_bounce、hard_bounce、complaint。不能唯一关联时只保存最小信封，邮箱 owner 可以在 unmatched 接口查看。原始云厂商通知应由经验证的网关规范化后再转发。

## 备份、升级和回滚

使用 pg_dump -Fc 对数据库做一致性备份，将主加密密钥单独保管。服务升级先停止 worker，备份，再执行 docker compose run --rm migrate 和 docker compose up -d --build。版本化迁移持有数据库锁。将备份恢复到独立数据库，使用原主密钥核对成员身份、活动数、抑制与投递记录。在开启外发前，补齐备份点之后的撤权、退订和已被服务商受理的事实；无法确定的提交留在 unknown。CI 在全新 Compose 部署创建活动、重启 Web，并将备份恢复到第二个数据库核对活动 ID。

用户付费、外部账号资格、服务商审核和多组织试点分别跟踪。上述合同测试使用合成数据和服务协议应答。真实 OAuth 测试使用租户专用账号，记录接收端 Message-ID、退订头和同线程回复后更新支持等级。 [里程碑验收条件](../engineering/delivery.md)
