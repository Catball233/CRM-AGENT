import type {
  AnalysisResult,
  ChatTurnResult,
  ContextBundle,
  KnowledgeEvidence,
  QuoteResult,
} from "@crm-agent/contracts";

export const ids = {
  conversation: "11111111-1111-4111-8111-111111111111",
  turn: "22222222-2222-4222-8222-222222222222",
  userMessage: "33333333-3333-4333-8333-333333333333",
  assistantMessage: "44444444-4444-4444-8444-444444444444",
  evidence: "55555555-5555-4555-8555-555555555555",
  quote: "66666666-6666-4666-8666-666666666666",
  quoteItem: "77777777-7777-4777-8777-777777777777",
  ruleVersion: "88888888-8888-4888-8888-888888888888",
  event: "99999999-9999-4999-8999-999999999999",
} as const;

export const validUserMessage = {
  message_id: ids.userMessage,
  role: "user",
  content: "我家90平方米旧房，想做全屋中档装修。",
  sequence: 1,
  created_at: "2026-08-05T06:00:00Z",
} as const;

export const validContextBundle = {
  contract_version: "1.0.0",
  conversation_id: ids.conversation,
  stage: "QUALIFYING",
  recent_messages: [validUserMessage],
  confirmed_facts: [],
  inferred_facts: [],
  conflicted_facts: [],
  memory_summary: null,
  current_quote: null,
  recalled_items: [],
  built_at: "2026-08-05T06:00:01Z",
} satisfies ContextBundle;

export const validAnalysisResult = {
  contract_version: "1.0.0",
  intent: "quote_request",
  stage_recommendation: "QUALIFYING",
  value_assessment: {
    level: "medium",
    evidence_refs: [
      {
        source_type: "message",
        source_id: ids.userMessage,
        excerpt: "想做全屋中档装修",
      },
    ],
    reason_codes: ["explicit_quote_interest"],
  },
  concerns: [],
  slot_updates: [
    {
      slot: "area_sqm",
      value: 90,
      status: "confirmed",
      source_refs: [{ source_type: "message", source_id: ids.userMessage }],
    },
  ],
  missing_fields: [
    { slot: "material_tier", reason: "报价需要材料档位", priority: 1 },
  ],
  recommended_next_action: "ask_missing_fields",
  knowledge_decision: {
    should_search: false,
    reason_codes: ["missing_quote_fields"],
    topics: [],
  },
  safety_flags: [],
  model_metadata: {
    provider: "aliyun_bailian",
    model_id: "qwen3.7-plus",
    prompt_version: "analysis-v1",
  },
} satisfies AnalysisResult;

export const validKnowledgeEvidence = {
  contract_version: "1.0.0",
  evidence_id: ids.evidence,
  knowledge_base_id: "kb-renovation-test",
  document_id: "quote-rules-sample",
  document_version: "1.0.0",
  chunk_id: "chunk-001",
  title: "默认城市中档全屋规则",
  excerpt: "中档全屋施工样例规则，仅用于本地测试。",
  score: 0.95,
  metadata: {
    category: "quote_rule",
    city: "默认测试城市",
  },
  candidate_rule_ids: ["RULE-WHOLE-MID-001"],
} satisfies KnowledgeEvidence;

export const validQuoteResult = {
  contract_version: "1.0.0",
  quote_id: ids.quote,
  conversation_id: ids.conversation,
  quote_version: 1,
  parent_quote_id: null,
  status: "estimated",
  currency: "CNY",
  parameters_snapshot: {
    city: "默认测试城市",
    area_sqm: 90,
    house_state: "old_renovation",
    service_scope: "whole_home",
    material_tier: "mid",
    quantities: {},
    special_requirements: [],
  },
  items: [
    {
      quote_item_id: ids.quoteItem,
      category: "construction",
      label: "全屋施工测试项",
      calculation_type: "AREA_MULTIPLY",
      quantity: 90,
      unit: "sqm",
      unit_price_fen: 128_000,
      amount_fen: 11_520_000,
      calculation_inputs: { area_sqm: 90, unit_price_fen: 128_000 },
      rule_ref: {
        rule_id: "RULE-WHOLE-MID-001",
        rule_version_id: ids.ruleVersion,
        version: 1,
      },
    },
  ],
  estimated_total_fen: 11_520_000,
  rule_versions: [
    {
      rule_id: "RULE-WHOLE-MID-001",
      rule_version_id: ids.ruleVersion,
      version: 1,
    },
  ],
  knowledge_evidence_ids: [ids.evidence],
  assumptions: ["仅用于本地验证"],
  exclusions: ["不包含正式量房后的变更"],
  disclaimer: "本结果为测试预估，最终以量房、施工方案和正式合同为准。",
  created_at: "2026-08-05T06:00:03Z",
} satisfies QuoteResult;

export const validChatTurnResult = {
  contract_version: "1.0.0",
  turn_id: ids.turn,
  conversation_id: ids.conversation,
  client_message_id: ids.userMessage,
  status: "COMPLETED",
  outcome: "quote",
  stage: "NEGOTIATION",
  user_message: validUserMessage,
  assistant_message: {
    message_id: ids.assistantMessage,
    role: "assistant",
    content: "已生成本地测试预估报价。",
    sequence: 2,
    created_at: "2026-08-05T06:00:03Z",
    cited_evidence_ids: [ids.evidence],
  },
  question_fields: [],
  quote: validQuoteResult,
  warnings: [],
  replayed: false,
  completed_at: "2026-08-05T06:00:03Z",
} satisfies ChatTurnResult;

export const invalidFixtures = {
  unsupportedIntent: { ...validAnalysisResult, intent: "interested" },
  valueWithoutEvidence: {
    ...validAnalysisResult,
    value_assessment: { level: "high", evidence_refs: [], reason_codes: ["unsupported"] },
  },
  incorrectQuoteTotal: { ...validQuoteResult, estimated_total_fen: 1 },
  unknownAnalysisField: { ...validAnalysisResult, unexpected_field: true },
} as const;
