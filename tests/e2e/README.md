# End-to-end tests

D-04 端到端测试框架，覆盖 S01–S12 本地 MVP 用户流程，先对**模拟链路**通过。

## 测试位置

场景测试位于 `apps/web/src/e2e/`（而非本目录），因为 `@testing-library/react`、`react`、`jsdom`、`@crm-agent/*` 仅作为 `apps/web` 的依赖安装，只有在 `apps/web` 下才能被解析。该目录已被 `vitest.config.mts` 的 `apps/**/*.test.tsx` 收录，无需额外配置。

- `apps/web/src/e2e/scenarios.test.tsx` — S01–S12 场景
- `apps/web/src/e2e/support/render-workspace.tsx` — 渲染 / 发送 / 重启辅助
- `apps/web/src/e2e/support/scripted-gateway.ts` — `ScriptedChatGateway` 测试替身（S08 等模拟链路无法自然产生的状态）

## 运行

```powershell
pnpm test                          # 全量
pnpm vitest run apps/web/src/e2e   # 仅 D-04 场景
```

## 场景与模拟链路映射

| 场景 | 驱动方式 | 断言要点 | 延后项 |
| --- | --- | --- | --- |
| S01 基础咨询 | MockChatGateway | consulting 回答、不报价、不高价值 | — |
| S02 缺字段 | MockChatGateway | 一次追问 city、不出金额 | — |
| S03 价值判断 | MockChatGateway | 中等价值、非高、不报价 | 顾虑 / 证据深度属真实模型 (INT-02) |
| S04 上下文追忆 | MockChatGateway | 多轮历史保留、v2 由 v1 调整而来 | 语义召回面积 / 预算属真实记忆 (INT-04) |
| S05 长对话记忆 | MockChatGateway | 三轮消息全部保留、无伪造上下文 | 确认 / 推断事实属真实记忆 (INT-04) |
| S06 合法报价 | MockChatGateway | v1 报价卡、合计 / 明细 / 版本、内部追溯字段不外泄 | — |
| S07 报价重做 | MockChatGateway | v2 调整版、parent 引用、v1 历史不覆盖 | — |
| S08 无激活 / 冲突规则 | ScriptedChatGateway | 不可用卡片、不出现金额 | mock 自然触发 no_active_rule 属 D-03 P1 修复 |
| S09 负向 / 无关 | MockChatGateway | 无关消息进咨询、不进报价 | 明确拒绝停止引导属真实模型 (INT-02/06) |
| S10 提示词注入 | MockChatGateway | safe_stop、不泄露密钥 / 提示词 | — |
| S11 未授权外部动作 | MockChatGateway | PII 输入拦截、无外部调用、不持久化 | — |
| S12 重启与重复 | MockChatGateway | 重启后恢复历史与当前报价 | 唯一消息去重属真实编排 (INT-06)，标记 it.todo |

## 约束

- 不修改 `apps/web/src/chat/mock-chat-gateway.ts`（D-03）；`no_active_rule` 的 mock 触发留待 D-03 P1 后续 Issue。
- 不引入 Playwright；真实 API 的 12 场景属 INT-06。
- `ScriptedChatGateway` 仅用于模拟链路无法自然产生的状态（S08），不替代真实编排。