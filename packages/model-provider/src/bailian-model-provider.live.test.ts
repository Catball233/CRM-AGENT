import { aiMemoryScenarioFixtures } from "@crm-agent/test-fixtures";
import { describe, expect, it } from "vitest";
import { AnalysisResultSchema } from "@crm-agent/contracts";
import { createBailianModelProviderFromEnv } from "./index";

const liveEnabled =
  process.env.B02_RUN_LIVE_MODEL_TEST === "1" && Boolean(process.env.DASHSCOPE_API_KEY?.trim());

describe.skipIf(!liveEnabled)("BailianModelProvider controlled live call", () => {
  it("returns one schema-valid analysis for fictional fixture data", async () => {
    const provider = createBailianModelProviderFromEnv({
      timeoutMs: 60_000,
      maxAttempts: 1,
    });

    const result = await provider.analyze(aiMemoryScenarioFixtures[0]!.analysis_request);

    expect(AnalysisResultSchema.safeParse(result).success).toBe(true);
  });
});
