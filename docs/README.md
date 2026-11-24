# Mailoop 设计文档

**make EDM great again**

Mailoop 面向由多名成员共同维护创作者关系的团队。这套文档定义从一句受众描述，到核查合作联系方式、使用成员邮箱发送，再到处理回复和复盘的完整工作流。[自托管与运行验收](operations/self-host.md) 收录持久化部署、凭据配置、支持矩阵与恢复流程。也可通过[本地原型](../README.md#run-the-prototype)运行合成研究、草稿审批、模拟投递与回信。下列文档描述完整产品的目标规格。

| 要解决的问题 | 从这里读 | 可用于什么决定 |
| --- | --- | --- |
| 市场上谁已经解决了哪些环节？ | [市场与定位](research/market.md) | 识别直接竞争者，决定首批试点和付费假设 |
| 参考项目有哪些已经跑通的设计？ | [参考项目评审](research/reference-review.md) | 确认继承的用户工作流和需要重新设计的工程边界 |
| 谁在何时审核什么？ | [产品方案](product/product.md) | 走完一条活动，确认角色、范围和成功条件 |
| 一封回信在界面和报表上如何体现？ | [Console 与指标](product/console.md) | 画页面、写查询、验收运营数据 |
| 服务怎么分工，重试后会发生什么？ | [系统架构](engineering/architecture.md) | 选择部署方式和持久化边界 |
| 不同 AI 怎么运行同一个 skill？ | [Agent、模型与 skills](engineering/agents-and-skills.md) | 实现工具权限、模型授权与研究结果校验 |
| 如何组织几十个独立授权的邮箱？ | [邮箱 connectors](engineering/connectors.md) | 实现授权、线程归属、排程和撤权 |
| 各模块之间传递什么？ | [数据与 API](engineering/contracts.md) · [研究结果样例](examples/research-result.json) | 实现 schema、事务、接口与事件消费者 |
| 第一个迭代做什么，什么算完成？ | [开发计划](engineering/delivery.md) | 安排工程分工、测试、部署和试点 |

公开资料的核对日期为 **2026-11-24**。可复核的项目代码尽量固定到具体提交。更新厂商授权、邮箱能力或指标定义时，同一个 PR 应同时修订依赖它的验收场景。
