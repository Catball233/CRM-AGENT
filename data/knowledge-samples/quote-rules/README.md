# 本地报价规则库：上海 DEMO

本目录是报价规则知识库的**公开检索索引**，用于未来创建独立的“报价规则库”。

仅上传 `demo-shanghai-public-rule-index-v1.md`。该文档包含可检索的规则标识、版本、适用条件和追问边界；不含金额、成本、供应商、折扣、毛利或审批信息。

在百炼中为该文档设置：

```text
knowledge_type=quote_rule
quote_eligible=true
environment=demo_only
status=active
rule_set=crm_agent_demo_shanghai_v1
city=上海
```

上传前必须确认本地 SQLite 已存在相同 `rule_id + rule_version` 且状态为 `active` 的规则。知识库不能作为本地报价规则的唯一来源或备份。
