# @crm-agent/test-fixtures

本包只保存虚构或脱敏的跨模块测试数据。公共 DTO 和运行时 Schema 必须从
`@crm-agent/contracts` 引用，不在 fixture 包中复制。

## B-01 AI／记忆样例

`src/ai-memory.ts` 提供七类可复用场景：

- 普通咨询：知识检索、低价值等级、无记忆写入；
- 报价意向但缺城市：按冻结验收基线标注中等价值，确认已有槽位、追问地区、不生成价格；
- 指代不明：证据不足返回 `unknown`，不猜测客户事实；
- 材料偏好推断：记录带置信度的推断事实，同时追问具体档位；
- 预算冲突：标记旧事实冲突并要求澄清，不静默覆盖；
- 长期追忆：通过摘要和历史报价恢复上次方案，新增售后顾虑；
- 提示词注入：输出安全标记并停止，不写入长期记忆。

每个场景同时包含：

- `analysis_request`：可由 `AnalysisRequestSchema` 解析的输入；
- `expected_analysis`：可由 `AnalysisResultSchema` 解析的标注输出；
- `expected_memory_plan`：可由 `MemoryMutationPlanSchema` 解析的记忆变更；
- `annotation`：准确率评测标签、证据来源和不可接受输出。

## 评测标签

标签使用 `维度:值`，当前维度包括：

- `intent:*`：期望意图；
- `value:*`：期望客户价值等级；
- `missing:*`：必须追问的缺失字段；
- `context:*`：上下文完整性；
- `memory:*`：无写入、确认事实、冲突或长期追忆；
- `knowledge:*`：是否应检索知识；
- `concern:*`：明确顾虑；
- `safety:*`：安全分类；
- `quote:*`：报价是否必须阻断。

运行 `pnpm test` 会验证所有输入／输出 Schema、标签一致性、证据可追溯性、
负向样例和 PII／凭据扫描。

测试还维护 fixture 实体到会话的归属表，并检查消息、事实、摘要、历史报价、
召回项和记忆写入引用均属于当前会话。仅通过公共 Schema 不代表跨会话来源合法。

样例中的 `model_metadata.model_id` 是与冻结 PRD 和 `.env.example` 对齐的确定性
测试元数据，不表示已执行真实 Provider 调用；真实调用结果由后续 Provider 验收记录。
