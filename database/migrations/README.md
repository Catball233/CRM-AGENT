# SQLite migrations

角色 C 维护这里的版本化 SQLite 迁移，角色 A 复核影响公共接口的数据结构。

## 规则

- 文件名使用 `NNNN_short_description.sql`，从 `0001` 开始连续递增。
- 已合并或已执行的迁移不得重写；结构变化必须新增迁移。
- 执行器会把版本、文件名和 SHA-256 写入 `schema_migrations`。同一版本内容变化时立即停止。
- 每个迁移在 `BEGIN IMMEDIATE` 事务中执行；失败后完整回滚。
- 打开数据库后始终启用 `foreign_keys`，并设置本地 `busy_timeout`。
- 金额保存为非负整数分，时间保存为带时区的 ISO 8601 字符串，业务 ID 使用 UUID 文本。
- JSON 字段在 SQLite 层使用 `json_valid` 检查，进入业务层后仍须使用公共 Zod Schema 校验。

## 本地命令

以下命令默认读取 `DATABASE_URL=file:./data/local.sqlite`，也可在命令末尾传入数据库路径：

```powershell
pnpm db:migrate -- data/local-c.sqlite
pnpm db:seed -- data/local-c.sqlite
pnpm db:verify -- data/local-c.sqlite
```

`pnpm db:rebuild -- data/local-c.sqlite` 会删除并重建指定的本地数据库，只允许操作仓库 `data/` 或系统临时目录内的 SQLite 文件。运行前必须自行确认目标路径。

四位开发者分别使用 `data/local-a.sqlite`、`data/local-b.sqlite`、`data/local-c.sqlite`、`data/local-d.sqlite` 等独立文件；数据库文件已被 `.gitignore` 排除，不通过 Git 共享。
