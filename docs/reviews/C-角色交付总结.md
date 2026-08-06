# 角色 C 交付总结

## 1. 角色与职责

角色 C 负责知识检索、SQLite 数据层、报价规则治理、确定性报价计算和人工对账。模型及知识库只提供意图、候选规则和证据，最终金额必须由 SQLite 中已激活且在有效期内的规则确定性计算。

本总结仅记录仓库中已经实现或已经验证的内容。C-05 在当前任务分支中完成，尚待创建 PR 和合并；阿里云后台配置属于外部准备，不等同于仓库代码交付。

## 2. Issue、PR、分支与提交记录

| 任务 | Issue | PR | 分支 | 主要提交主题 | 状态 |
| --- | --- | --- | --- | --- | --- |
| C-01 SQLite Schema、迁移与种子 | #3 | #22 | `feature/c-01-sqlite-schema` | `feat(C-01): add SQLite schema migrations and seed` | 已合并 |
| C-02 SQLite Repository 与事务 | #12 | #26 | `feature/c-02-sqlite-repositories` | `feat(C-02): add SQLite repositories and transactions` | 已合并 |
| C-03 百炼知识检索 Provider | #13 | #32 | `feature/c-03-bailian-knowledge-provider` | `feat(C-03): add Bailian knowledge provider` | 已合并 |
| C-04 规则导入、校验与激活 | #14 | #36 | `feature/c-04-rule-import-activation` | `feat(C-04): add rule import validation and activation` | 已合并 |
| C-05 确定性报价引擎 | #15 | 待创建 | `feature/c-05-deterministic-quote-engine` | `feat(C-05): add deterministic quote engine` | 本分支已实现并完成本地验证，待 PR |

采购、促销与利润底线的 Contract v1.1 设计基线记录在 Issue #20、PR #23 和 `docs/specs/接口契约-v1.1-采购促销与利润底线-设计提案.md`。当前公共 Runtime Schema 仍为 v1.0；C-05 未擅自发布 v1.1 公共 Schema。

## 3. 阿里云百炼配置结果

- 已创建并上传装修报价知识库，使用文档搜索和基础文档问答。
- 文档采用智能切分，最大分段长度为 1200，Metadata 抽取关闭。
- 知识库检索测试已经成功。
- “装修”百炼应用已经发布并完成 API 测试。
- 仓库中的 C-03 使用原始知识检索接口封装 `KnowledgeProvider`，并提供离线 `FakeKnowledgeProvider`。
- 运行时只通过环境变量名称读取配置：`DASHSCOPE_API_KEY`、`BAILIAN_WORKSPACE_ID`、`BAILIAN_KNOWLEDGE_BASE_ID`、`BAILIAN_KNOWLEDGE_DOCUMENT_VERSION`、`BAILIAN_MIN_SCORE`。

上述记录不包含 API Key、Workspace ID、知识库 ID、应用 ID或账号信息。

## 4. SQLite、迁移、种子与 Repository

C-01 建立了版本化迁移和虚构种子数据，覆盖会话、消息、事实、规则版本、规则条目、报价版本、报价明细和知识证据。金额使用整数分，时间使用 ISO 8601。迁移脚本支持从空数据库重建并可重复安全执行。

C-02 提供会话、消息、事实、记忆、规则版本和报价版本 Repository，并定义消息保存、规则激活和报价保存的事务边界。失败注入测试验证了完整回滚；报价版本只新增、不覆盖历史；测试同时覆盖跨会话隔离、幂等冲突和重启恢复。

C-04 新增迁移 `0003_rule_import_and_activation.sql`，保存供应商报价快照、促销规则、成本引用和激活状态。C-05 新增迁移 `0004_quote_internal_calculations.sql`，保存仅服务端可见的计算账本、成本明细、促销引用和幂等请求摘要。

## 5. 知识检索调用链与失败处理

调用链为：业务服务构造检索请求 → `KnowledgeProvider` 调用百炼原始知识检索 → 校验响应 → 映射为 `KnowledgeEvidence` → 报价引擎核对证据与候选规则 → SQLite 激活规则计算金额。

Provider 处理无结果、低置信度、超时、HTTP 429、5xx 和非法响应；429 与 5xx 最多重试一次。日志不记录 API Key、完整请求头或完整敏感知识切片。知识证据不能直接产生、覆盖或激活最终价格。

## 6. 报价规则导入、校验、激活与版本管理

C-04 将规则先导入为草稿，完成 Schema 与业务校验后才能激活。同一适用范围只能有一个有效激活版本；激活新版本保留旧版本历史。校验覆盖地区、场景、材料、工种、设计师档位、有效期、冲突、成本引用、供应商报价快照、促销互斥/叠加、最低利润率和最大优惠率。

负成本、过期供应商报价、非法利润率、规则冲突或不可追溯的数据不能激活。AI 和知识检索没有规则激活权限。

## 7. C-05 确定性报价与利润底线

C-05 只读取已激活且有效的 SQLite 规则，并使用整数分与确定性舍入计算设计费、材料费、人工费、施工费、家具家电、配送、安装、质保和附加费用。每条报价明细关联规则 ID 与规则版本。

家具、家电和软装代采使用有效供应商快照中的批发成本，并将配送、安装和质保计入内部总成本。现金优惠、赠品和免费服务均受激活促销规则约束；赠品和免费服务即使客户可见价格为零，其内部成本仍计入项目总成本。

最低成交金额使用：

```text
floor_revenue_fen =
ceil(total_cost_fen * 10000 / (10000 - minimum_margin_bps))
```

现金优惠同时受最大优惠率和利润空间限制。低意图客户只能使用已激活且允许该意图等级的促销；高意图客户不能被模型随意加价或绕过规则。供应商快照过期、规则缺失、规则冲突、证据不足或优惠突破底线时返回不可报价/不可调整结果，不生成部分账本。

相同幂等请求返回同一报价版本；相同幂等键携带不同请求时拒绝。调整方案创建新报价和递增版本，并保留父报价及历史记录。公共报价和内部计算账本在同一事务中保存。

## 8. 验证与人工对账

C-05 最终本地验证结果：

- `pnpm typecheck`：通过。
- `pnpm test`：207 项通过，2 项受控跳过，共 209 项。
- `pnpm build`：通过。
- C-05 与 SQLite 定向集成测试：25 项通过。
- Node 24 运行 `node:sqlite` 时出现实验性功能提示，不影响测试结果。

虚构人工对账样例位于 `data/quote-rule-samples/c05-manual-reconciliation.json`：

```text
subtotal_fen = 1,100,000
total_cost_fen = 792,000
minimum_margin_bps = 2,000
floor_revenue_fen = 990,000
cash_discount_fen = 110,000
final_revenue_fen = 990,000
```

引擎输出与人工计算一致。测试还覆盖不同面积、地区、场景、材料数量、设计师档位、阶梯/系数/附加费、家具家电采购、现金优惠、赠品、免费服务、恰好触底、突破底线、过期快照、规则冲突、证据不足、幂等、历史版本和事务回滚。

C-01 至 C-04 的 PR 均执行了适用的 `pnpm typecheck`、`pnpm test` 和 `pnpm build`，并在评审后合并；各次精确计数以对应 PR 的验证记录为准。

## 9. 在另一台电脑复现

环境要求：Git、Node.js 24、pnpm 11。

```powershell
git clone https://github.com/Catball233/CRM-AGENT.git
Set-Location CRM-AGENT
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

验证 SQLite 空库迁移时，应使用仓库脚本和临时数据库路径，不把生成的数据库提交到 GitHub。验证 C-03 的真实百炼调用时，在本地 `.env` 中配置所需环境变量；没有真实凭据时使用 `FakeKnowledgeProvider` 运行离线测试。

在 C-05 合并前复现当前实现，需要检出 `feature/c-05-deterministic-quote-engine`；合并后直接使用最新 `main`。

## 10. 已知限制与后续工作

- Contract v1.1 已批准的是设计基线，公共 Runtime Schema 尚未由独立任务正式实现；C-05 当前通过 v1.0 `QuoteRequest`/`QuoteResult` 与服务端内部账本实现核心计算边界。
- 现有 v1.0 公共报价契约仍保留规则/证据引用；客户侧完全隐藏这些标识需要后续 v1.1 公共投影任务完成。
- C-05 报价包尚未接入 NestJS 会话 API；需要由集成任务把 B 的意图结果、C-03 的证据、C-05 的计算结果和 D 的客户页面串联。
- 当前规则、供应商快照和对账样例全部为虚构数据，没有接入真实供应商系统、库存、物流、支付、合同或订单。
- 百炼真实调用的可用性仍取决于本地凭据、外部服务状态、知识库版本和配额。

## 11. 未上传内容

以下内容明确不上传 GitHub：

- `.env`、API Key 和任何真实凭据。
- Workspace ID、知识库 ID、应用 ID 和账号信息。
- 本地 SQLite 数据库文件。
- 阿里云账号及后台截图。
- 调试日志、依赖目录和构建产物。
- 未脱敏客户数据、真实姓名、电话、地址等 PII。
- 未经批准的真实商业价格、供应商底价和真实利润参数。

