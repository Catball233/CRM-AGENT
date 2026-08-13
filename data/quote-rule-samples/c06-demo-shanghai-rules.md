# 上海装修报价演示规则（虚构）

本文件及 `c06-demo-shanghai-bundle.json` 仅用于 CRM-AGENT 功能演示和自动化验收。
它们不构成真实报价、供应商报价、审批记录或对客户的价格承诺。

## 演示规则

| rule_id | 规则 | 适用条件 | 演示计算 |
| --- | --- | --- | --- |
| DEMO-SH-DESIGN-AREA-001 | 设计服务面积项 | 上海、全屋、`demo_standard`、设计档位 `demo_standard` | 120 元/㎡ × 面积 |
| DEMO-SH-MATERIAL-AREA-001 | 主材面积项 | 上海、全屋、`demo_standard` | 880 元/㎡ × 面积 |
| DEMO-SH-OLDHOME-SURCHARGE-001 | 旧房改造附加项 | 上海、全屋、旧房改造 | 固定 6,000 元 |

在 90㎡、上海、全屋、旧房改造、`demo_standard` 场景中，演示总价为 96,000 元。
所有金额为虚构整数分值，仅用于验证“知识检索 → 候选规则 → 本地规则引擎 → 报价卡”的链路。
