import { aiMemoryScenarioFixtures } from "@crm-agent/test-fixtures";
import { describe, expect, it } from "vitest";
import { AnalysisResultSchema } from "@crm-agent/contracts";
import { createBailianModelProviderFromEnv } from "./index";

const liveEnabled =
  process.env.B02_RUN_LIVE_MODEL_TEST === "1" && Boolean(process.env.DASHSCOPE_API_KEY?.trim());

describe.skipIf(!liveEnabled)("BailianModelProvider controlled live call", () => {
  it("extracts a complete fictional Shanghai demo quote request", async () => {
    const provider = createBailianModelProviderFromEnv({
      timeoutMs: 90_000,
      maxAttempts: 1,
    });

    const fixture = aiMemoryScenarioFixtures[0]!;
    const request = {
      ...fixture.analysis_request,
      current_message: {
        ...fixture.analysis_request.current_message,
        content:
          "我要在上海做全屋旧房装修，建筑面积90㎡，服务范围全屋，材料档位和设计师档位均为演示标准，请按公开演示规则生成报价。",
      },
    };

    const result = await provider.analyze(request);

    expect(AnalysisResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      intent: "quote_request",
      stage_recommendation: "QUALIFYING",
      recommended_next_action: "prepare_quote",
      missing_fields: [],
      knowledge_decision: expect.objectContaining({ should_search: true }),
    });
    expect(result.slot_updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slot: "city", value: "上海", status: "confirmed" }),
        expect.objectContaining({ slot: "area_sqm", value: 90, status: "confirmed" }),
        expect.objectContaining({ slot: "house_state", value: "old_renovation", status: "confirmed" }),
        expect.objectContaining({ slot: "service_scope", value: "whole_home", status: "confirmed" }),
        expect.objectContaining({ slot: "material_tier", value: "demo_standard", status: "confirmed" }),
        expect.objectContaining({ slot: "designer_tier", value: "demo_standard", status: "confirmed" }),
      ]),
    );
  }, 95_000);
});
