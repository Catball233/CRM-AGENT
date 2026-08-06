# CRM-AGENT

面向装修行业的本地 AI 销售与预估报价 MVP。系统通过聊天网页验证意图识别、客户价值判断、知识库介入、上下文追忆、短期/长期记忆，以及基于 SQLite 版本化规则的确定性报价。

## 当前范围

- 本地运行：`localhost + SQLite`。
- 前端：Next.js。
- API 与会话编排：NestJS。
- 模型与知识检索：阿里云百炼。
- 公共契约：TypeScript + Zod 运行时 Schema。
- 测试数据：仅使用虚构或脱敏装修业务数据。

本期不包含公网部署、真实客户 PII、人工接管、RDS、Redis、WebSocket、合同、订单或支付。

## 仓库结构

```text
CRM-AGENT/
├── apps/                         # 可运行应用
│   ├── web/                      # D：Next.js 本地聊天页与报价卡片
│   └── api/                      # A：NestJS API、会话编排与错误处理
├── packages/                     # 跨应用共享包
│   ├── contracts/                # A 牵头：运行时 Schema、类型、事件与错误码
│   └── test-fixtures/            # B/C/D：标准输入、错误样例与预期结果
├── database/                     # C：SQLite 数据定义
│   ├── migrations/               # 版本化迁移
│   └── seed/                     # 虚构/脱敏种子数据
├── data/                         # 可提交的本地 MVP 样例内容
│   ├── knowledge-samples/        # C：知识检索样例
│   └── quote-rule-samples/       # C：报价规则与人工对账样例
├── tests/                        # 跨模块测试
│   ├── contract/                 # 公共契约测试
│   ├── integration/              # API、记忆、知识和报价集成测试
│   └── e2e/                      # D：S01–S12 用户流程测试
├── docs/                         # 产品与研发文档基线
│   ├── specs/                    # 接口契约等研发规格
│   ├── reviews/                  # 产品与技术评审归档
│   └── research/                 # 需求调研和清洗稿
├── .github/                      # CI、PR 模板与代码所有权
├── .env.example                  # 环境变量名称模板，不含真实密钥
├── .gitignore                    # 密钥、依赖、构建物和本地数据库忽略规则
├── package.json                  # 单仓库统一脚本
├── pnpm-workspace.yaml           # pnpm workspace 范围
└── tsconfig.base.json            # 全仓 TypeScript 基础配置
```

## 文档入口

- [项目文档索引](docs/00-项目文档索引.md)
- [本地 MVP PRD](docs/01-PRD-v1.0-冻结候选.md)
- [验收策略与阶段门禁](docs/03-验收策略与阶段门禁.md)
- [解决方案设计](docs/04-解决方案设计.md)
- [四人项目执行计划](docs/05-项目执行计划.md)
- [接口契约 v1.0](docs/specs/接口契约-v1.0.md)

## 四人代码边界

| 角色 | 主要责任 |
| --- | --- |
| A | 技术与集成、公共契约、NestJS 编排、幂等和主分支健康 |
| B | AI 分析、意图/价值判断、上下文和短期/长期记忆 |
| C | 知识检索、SQLite、规则导入、报价计算和对账 |
| D | Next.js 页面、流式事件、报价卡片、模拟 API 和端到端测试 |

## GitHub 协作与上传规范

### 基本链路

```text
Issue → 任务分支 → 本地提交 → push 任务分支 → PR 指向 main
      → 自动检查与代码评审 → 合并 PR → 验收 Issue → 推进 Milestone
```

- `git pull` 用于把远程更新下载到本地；`git push` 用于上传本地提交。
- 禁止直接把开发提交 push 到 `main`。每项开发任务必须从最新 `main` 建立独立任务分支。
- 一个分支和一个 PR 只处理一个主 Issue。任务过大时先拆分 Issue，不在同一 PR 混入无关修改。
- PR 的 base 必须是 `main`，head 必须是任务分支；PR 本身不会代替 `git push` 上传代码。
- `main` 应始终保持可安装、可迁移、可启动并可运行基础测试。

### 分支和提交命名

任务分支格式：

```text
feature/<任务ID>-<简短说明>
fix/<任务ID>-<简短说明>
test/<任务ID>-<简短说明>
docs/<任务ID>-<简短说明>
```

示例：

```text
feature/a-03-session-api
feature/b-02-model-provider
feature/c-05-quote-engine
feature/d-02-chat-ui
docs/all-01-g0-rules
```

提交信息格式：

```text
<类型>(<任务ID>): <变更摘要>
```

允许的常用类型为 `feat`、`fix`、`test`、`docs`、`chore`，例如：

```text
feat(A-03): add conversation message endpoint
test(C-05): add deterministic quote cases
docs(ALL-01): document G0 collaboration rules
```

### 从 Issue 开始开发

开始编码前：

1. 打开对应 Issue，确认负责人、Milestone、Labels、完成定义和前置依赖。
2. 前置 Issue 未完成时，不绕过依赖直接集成；先在 Issue 中记录阻塞原因。
3. 将本地 `main` 更新到远程最新状态。
4. 使用 Issue 的任务 ID 创建分支。

```powershell
git switch main
git pull --ff-only origin main
git switch -c feature/a-03-session-api
```

如果分支开发期间 `main` 已更新，先同步后再继续提交：

```powershell
git fetch origin
git merge origin/main
```

发生冲突时应在本地解决并重新运行检查，不通过强制 push 覆盖其他人的历史。

### 检查、提交和 push

提交前只暂存属于当前 Issue 的文件，不使用 `git add .`、`git add -A` 或 `git add --all`：

```powershell
git status --short
git diff -- apps/api packages/contracts
git add -- apps/api packages/contracts
git diff --cached
git commit -m "feat(A-03): add conversation message endpoint"
```

首次上传任务分支：

```powershell
git push -u origin feature/a-03-session-api
```

后续上传同一分支：

```powershell
git push
```

push 前至少执行与改动相关的检查；提交 PR 前执行统一检查：

```powershell
pnpm typecheck
pnpm test
pnpm build
```

不得 push `.env`、API Key、真实 PII、个人 SQLite 文件、日志、依赖目录或构建产物。不得使用普通 `--force` 覆盖共享分支。

### 创建和评审 PR

PR 标题应包含任务 ID：

```text
[A-03] 实现 NestJS 会话与消息 API
```

PR 正文至少包含：

```md
## 关联 Issue

Closes #7

## 修改内容

- 实现内容

## 验证结果

- [ ] typecheck
- [ ] test
- [ ] build

## 风险与限制

- 已知限制或“无”
```

- 使用 `Closes #编号` 将 PR 与主 Issue 关联；PR 合并到 `main` 后，GitHub 自动关闭对应 Issue。
- 如果 PR 只是任务的一部分且不能满足 Issue 完成定义，使用 `Refs #编号`，Issue 保持开放；最终完成任务的 PR 再使用 `Closes #编号`。
- 公共 Schema：A 与受影响模块负责人评审。
- SQLite 迁移：C 创建，A 复核；已合并迁移不得重写。
- AI/记忆：B 主责，A 或 C 评审。
- 知识/报价：C 主责，A 和 B 至少一人评审。
- 前端/E2E：D 主责，A 或对应输出负责人评审。
- 检查失败、评审未通过、对话未解决或存在未披露的契约变更时，不合并 PR。

PR 合并后，在 GitHub PR 页面点击 `Delete branch`，或确认已经合并后删除远程任务分支；随后删除本地任务分支，并从最新 `main` 开始下一项任务：

```powershell
git switch main
git pull --ff-only origin main
git push origin --delete feature/a-03-session-api
git branch -d feature/a-03-session-api
```

### Issue 使用规则

[Issues](https://github.com/Catball233/CRM-AGENT/issues) 是任务执行和验收的事实来源：

- 每个 Issue 只有一个主负责人，并分配一个 Milestone。
- Labels 用于表达模块、类型、优先级和异常状态；不使用标题文字代替 Labels。
- Issue 正文保存稳定的目标、范围和完成定义；日常进度、验证证据和阻塞变化写在评论中。
- 开始任务时确认前置依赖；阻塞超过一个工作日时添加 `blocked` Label，并在评论中说明责任人和解除条件。
- PR 创建后，在 Issue 和 PR 两侧都应能看到关联关系。
- 只有代码已合并、验收项通过且证据已记录时才关闭 Issue。无代码任务由负责人提交证据，评审人确认后手动关闭。
- 需求范围变化时先更新或拆分 Issue，再改代码；不要在 PR 中静默扩大范围。

### Milestone 使用规则

[Milestones](https://github.com/Catball233/CRM-AGENT/milestones) 用于管理阶段目标，不代替 Issue 或每日任务看板：

| Milestone | 当前范围 | 完成条件 |
| --- | --- | --- |
| M0 - G0 接口与工程基线 | #1–#6，共 6 个 Issue | #1–#5 完成并通过走查，#6 完成 G0 门禁确认 |
| M1 - 核心模块并行开发 | #7–#18，共 12 个 Issue | 四个模块可独立运行，并达到对应 G1/G2 检查要求 |

- Issue 只能归属一个当前 Milestone；跨阶段工作应拆分 Issue。
- 截止日期是计划基线，不代表自动验收通过；Milestone 只在全部必需 Issue 完成且门禁通过后关闭。
- M0 的 #6 是进入 M1 的总门禁。未完成 G0 时，M1 Issue 可以澄清和准备，但不得绕过冻结契约进行真实集成。
- 每日同步查看开放 Issue、阻塞项和即将到期任务；每个 Milestone 结束时按 `docs/03-验收策略与阶段门禁.md` 记录验收证据。
- 新增任务必须先判断属于当前 Milestone、后续 Milestone 还是 Post-MVP；不得为了显示进度而把未验收 Issue 提前关闭。

## 本地启动

要求：Node.js、pnpm，以及可用的阿里云百炼测试凭据。

```powershell
pnpm install
Copy-Item .env.example .env
pnpm dev
```

统一检查：

```powershell
pnpm typecheck
pnpm test
pnpm build
```

当前仓库仍处于工程初始化阶段；具体可运行能力以项目门禁和测试结果为准。

## 安全规则

- 不提交 `.env`、API Key、个人 SQLite 文件、日志或构建产物。
- 不提交真实姓名、手机号、客户地址或企业未批准的真实价格。
- 百炼输出、知识切片、HTTP 输入和 SQLite 结构化数据进入业务层前必须通过运行时 Schema 校验。
- AI 和知识检索不能直接激活规则、写入权威金额或执行外部动作。

# CRM-AGENT PR 审查与合并规则

## 1. PR 提交前：作者三轮自审

每个 PR 在提交评审前必须完成三轮独立自审，并在 PR 描述中勾选：

- [ ] 第一轮：需求与范围
  - 仅实现关联 Issue 的范围。
  - 未修改无关公共契约、迁移、配置或生成文件。
  - 不含密钥、真实 PII、真实客户数据或未批准价格。

- [ ] 第二轮：代码逻辑与边界
  - 覆盖正常、缺失、异常、冲突和安全降级路径。
  - 校验状态流转、幂等、跨会话隔离、金额/版本/时间等关键约束。
  - 不依赖模型猜价；报价只由确定性规则服务生成。

- [ ] 第三轮：验证与可维护性
  - 已执行适用的 typecheck、test、build 或静态检查。
  - 新增/修改的测试可证明关键验收项。
  - PR 描述准确列出限制、风险和关联 Issue。

## 2. Codex 审查的验收效力

- Codex 静态审查通过，默认视为“样例走查已完成”。
- 若 Issue 的其余完成定义与 PR 证据均满足，则允许：
  1. 关闭关联 Issue；
  2. 合并 PR 到 `main`。
- 例外：Issue 明确要求真实 API、真实账号、外部副作用、客户可见行为或人工业务验收时，Codex 审查不能替代该项真实验收。

## 3. 缺陷等级与合并策略

| 级别 | 含义 | 默认处理 | 是否可合并 |
|---|---|---|---|
| P0 | 安全、数据损坏、越权、核心功能不可用、严重契约破坏 | 必须修复并复审 | 否 |
| P1 | 关键逻辑错误、验收项缺失、跨模块不一致、可能导致错误业务结果 | 默认必须修复并复审 | 否；仅 A 书面例外批准时可合并 |
| P2 | 非阻塞改进、边界完善、可读性、覆盖率或后续优化 | 建议记录，不强制修改 | 是 |

P1 例外合并必须同时满足：

- A 明确接受风险；
- 创建后续 Issue，标注优先级和负责人；
- PR 中写明未修复原因与临时边界；
- 不涉及安全、真实 PII、报价金额正确性、跨会话隔离、公共契约或数据迁移。

## 4. PR Review 模板

### 审查范围

- PR：
- 关联 Issue：
- 基线分支 / HEAD：
- 审查方式：静态审查 / 本地验证 / CI 结果
- 已检查的验收项：

### 证据

- 变更文件：
- 契约/数据影响：
- 测试或 CI：
- 样例走查证据：
- 未执行的验证及原因：

### 阻塞项

#### P0

- 无 / [文件:行号] 问题、影响、复现或代码证据、必须修复条件。

#### P1

- 无 / [文件:行号] 问题、影响、复现或代码证据、必须修复条件。
- 如申请例外合并：关联风险 Issue、A 的批准记录、临时边界。

### 非阻塞建议

#### P2

- 无 / [文件:行号] 建议、收益、可后续处理方式。

### 可验收项

- [ ] 每项关联 Issue 完成定义均有证据。
- [ ] PR 范围与关联 Issue 一致。
- [ ] 公共契约、数据安全和业务边界未被破坏。
- [ ] 作者已完成三轮自审。
- [ ] Codex 样例走查通过。
- [ ] 必要 CI 通过。
- [ ] 如涉及真实验收，真实验收已完成并有证据。

### 结论

- 结论：通过 / 需修改 / 风险例外通过
- 可否关闭 Issue：可以 / 不可以
- 可否合并 main：可以 / 不可以
- 合并前动作：
- 合并后跟进：
