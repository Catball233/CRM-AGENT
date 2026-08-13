# 上海装修报价演示：公开检索规则索引（DEMO-ONLY）

> 文档版本：1.0.0-demo  
> 环境：demo_only  
> 适用范围：仅用于 CRM-AGENT 功能演示与检索联调。  
> 安全边界：本文件不含成本、单价、供应商、折扣上限或真实业务审批信息。具体金额只能由本地报价服务按已激活的演示规则计算。

---

## 规则：上海全屋设计服务面积项

rule_id: DEMO-SH-DESIGN-AREA-001  
rule_version: 1  
status: active  
environment: demo_only  
city: 上海  
effective_from: 2026-08-01T00:00:00Z  
effective_to:  
category: design  
service_scope: whole_home  
required_fields: city, area_sqm, house_state, service_scope, material_tier, designer_tier  
search_keywords: 上海, 全屋, 设计, 演示标准, 面积

全屋装修中的设计服务适用规则。仅在上海、全屋服务和演示标准设计档位下适用。
当设计档位或服务范围不明确时，必须先追问，不得推测金额。
本规则不包括施工、主材和旧房改造附加项。

---

## 规则：上海全屋主材面积项

rule_id: DEMO-SH-MATERIAL-AREA-001  
rule_version: 1  
status: active  
environment: demo_only  
city: 上海  
effective_from: 2026-08-01T00:00:00Z  
effective_to:  
category: material  
service_scope: whole_home  
required_fields: city, area_sqm, house_state, service_scope, material_tier  
search_keywords: 上海, 全屋, 主材, 演示标准, 面积

全屋装修中的主材适用规则。仅在上海、全屋服务和演示标准材料档位下适用。
当材料档位或服务范围不明确时，必须先追问，不得推测金额。
本规则不包括设计、施工和旧房改造附加项。

---

## 规则：上海全屋旧房改造附加项

rule_id: DEMO-SH-OLDHOME-SURCHARGE-001  
rule_version: 1  
status: active  
environment: demo_only  
city: 上海  
effective_from: 2026-08-01T00:00:00Z  
effective_to:  
category: surcharge  
service_scope: whole_home  
required_fields: city, house_state, service_scope  
search_keywords: 上海, 全屋, 旧房, 改造, 附加

旧房全屋改造的附加服务适用规则。仅在上海、全屋服务、旧房改造时适用。
房屋状态未确认或存在特殊拆改时，必须先追问或人工确认，不得推测金额。
本规则不适用于毛坯或新房精装。

---

## 百炼应用回答约束

仅根据检索结果说明规则适用条件与缺失字段。
不得生成、推测或展示金额、成本、单价、毛利、供应商信息或折扣上限。
只有外部报价服务返回的 quote 结果才能展示金额。
城市不匹配、规则过期、状态非 active 或字段不完整时，明确说明暂不能报价。
