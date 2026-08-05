# SQLite seed data

这里只保存虚构或脱敏的本地 MVP 种子数据。

- 文件名使用 `NNNN_short_description.sql`。
- 执行器记录每个种子文件的 SHA-256；已执行文件被修改时停止，避免静默改变测试基线。
- 种子必须可重复执行，不能依赖真实客户、真实地址、企业未批准价格或阿里云标识。
- 当前样例使用“示例市”、固定 UUID、`fixture://` 来源和明确标注的测试金额。

```powershell
pnpm db:migrate -- data/local-c.sqlite
pnpm db:seed -- data/local-c.sqlite
pnpm db:verify -- data/local-c.sqlite
```
