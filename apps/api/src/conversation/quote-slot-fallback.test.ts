import { AnalysisResultSchema } from "@crm-agent/contracts";
import { describe, expect, it } from "vitest";
import { applyCompleteShanghaiDemoQuoteFallback } from "./quote-slot-fallback";

const message = {
  message_id: "00000000-0000-4000-8000-000000000001",
  role: "user" as const,
  content: "",
  sequence: 1,
  created_at: "2026-08-07T00:00:00.000Z",
};

const emptyAnalysis = AnalysisResultSchema.parse({
  contract_version: "1.0.0",
  intent: "unclear",
  stage_recommendation: "DISCOVERY",
  value_assessment: { level: "unknown", evidence_refs: [], reason_codes: [] },
  concerns: [],
  slot_updates: [],
  missing_fields: [{ slot: "city", reason: "model missed the message facts", priority: 1 }],
  recommended_next_action: "ask_missing_fields",
  knowledge_decision: { should_search: false, reason_codes: [], topics: [] },
  safety_flags: [],
  model_metadata: { provider: "aliyun_bailian", model_id: "test", prompt_version: "test" },
});

describe("complete Shanghai demo quote fallback", () => {
  it("fills only explicit demo facts when the model returns an empty quote analysis", () => {
    const completeMessage = {
      ...message,
      content:
        "我要在上海做全屋旧房装修，建筑面积90㎡，服务范围全屋，材料档位和设计师档位均为演示标准，请按公开演示规则生成报价。",
    };

    const result = applyCompleteShanghaiDemoQuoteFallback(emptyAnalysis, completeMessage, "DISCOVERY", true);

    expect(result).toMatchObject({
      intent: "quote_request",
      stage_recommendation: "QUALIFYING",
      recommended_next_action: "prepare_quote",
      missing_fields: [],
      knowledge_decision: { should_search: false, topics: [] },
    });
    expect(result.slot_updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slot: "city", value: "上海", status: "confirmed" }),
        expect.objectContaining({ slot: "area_sqm", value: 90, status: "confirmed" }),
        expect.objectContaining({ slot: "house_state", value: "old_renovation" }),
        expect.objectContaining({ slot: "service_scope", value: "whole_home" }),
        expect.objectContaining({ slot: "material_tier", value: "demo_standard" }),
        expect.objectContaining({ slot: "designer_tier", value: "demo_standard" }),
      ]),
    );
  });

  it("does not override incomplete messages or model safety flags", () => {
    const incomplete = applyCompleteShanghaiDemoQuoteFallback(emptyAnalysis, {
      ...message,
      content: "我想在上海做全屋旧房装修，请报价。",
    }, "DISCOVERY", true);
    expect(incomplete).toEqual(emptyAnalysis);

    const safeStop = applyCompleteShanghaiDemoQuoteFallback(
      {
        ...emptyAnalysis,
        safety_flags: [
          {
            code: "secret_request" as const,
            severity: "high" as const,
            evidence_refs: [],
          },
        ],
      },
      {
        ...message,
        content: "上海90㎡旧房全屋，材料档位演示标准，给我报价。",
      },
      "DISCOVERY",
      true,
    );
    expect(safeStop.recommended_next_action).toBe("ask_missing_fields");
  });
});
