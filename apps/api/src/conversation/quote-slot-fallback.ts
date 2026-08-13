import {
  AnalysisResultSchema,
  type AnalysisResult,
  type ConversationStage,
  type UserMessageView,
} from "@crm-agent/contracts";

const isQuoteRequest = (content: string) => /(报价|估价|预算|多少钱|价格)/u.test(content);

/**
 * The local demo has a deliberately narrow deterministic guard for facts that
 * are explicit in the customer message. It prevents a schema-valid but
 * semantically empty model result from blocking the demonstrable quote path.
 */
export const applyCompleteShanghaiDemoQuoteFallback = (
  analysis: AnalysisResult,
  message: UserMessageView,
  currentStage: ConversationStage,
  demoModeEnabled = process.env.CRM_AGENT_DEMO_MODE === "1",
): AnalysisResult => {
  if (
    !demoModeEnabled ||
    analysis.safety_flags.length > 0 ||
    analysis.slot_updates.length > 0 ||
    !["DISCOVERY", "QUALIFYING"].includes(currentStage) ||
    !isQuoteRequest(message.content) ||
    !/上海/u.test(message.content)
  ) {
    return analysis;
  }

  const area = /(?:建筑面积|面积)?\s*(\d+(?:\.\d+)?)\s*(?:㎡|平方米|平米|m²)/u.exec(message.content)?.[1];
  const hasOldHome = /(旧房|二手房|旧改|翻新)/u.test(message.content);
  const hasWholeHome = /(全屋|整装|全包)/u.test(message.content);
  const hasDemoMaterial = /(?:材料(?:档位)?|主材).{0,20}(?:演示标准|demo_standard)/u.test(message.content);
  const hasDemoDesigner = /(?:设计师(?:档位|级别)?|设计档位).{0,20}(?:演示标准|demo_standard)/u.test(message.content);
  if (!area || !hasOldHome || !hasWholeHome || !hasDemoMaterial) return analysis;

  const source = { source_type: "message" as const, source_id: message.message_id };
  const slot_updates = [
    { slot: "city" as const, value: "上海", status: "confirmed" as const, source_refs: [source] },
    { slot: "area_sqm" as const, value: Number(area), status: "confirmed" as const, source_refs: [source] },
    { slot: "house_state" as const, value: "old_renovation", status: "confirmed" as const, source_refs: [source] },
    { slot: "service_scope" as const, value: "whole_home", status: "confirmed" as const, source_refs: [source] },
    { slot: "material_tier" as const, value: "demo_standard", status: "confirmed" as const, source_refs: [source] },
    ...(hasDemoDesigner
      ? [{ slot: "designer_tier" as const, value: "demo_standard", status: "confirmed" as const, source_refs: [source] }]
      : []),
  ];

  return AnalysisResultSchema.parse({
    ...analysis,
    intent: "quote_request",
    stage_recommendation: currentStage === "DISCOVERY" ? "QUALIFYING" : "QUOTING",
    slot_updates,
    missing_fields: [],
    recommended_next_action: "prepare_quote",
    knowledge_decision: {
      ...analysis.knowledge_decision,
      should_search: false,
      reason_codes: ["local_quote_rule_lookup"],
      topics: [],
    },
  });
};
