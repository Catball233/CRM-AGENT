import { KnowledgeSearchResultSchema } from "@crm-agent/contracts";
import { describe, expect, it } from "vitest";
import { createBailianKnowledgeProviderFromEnv, type KnowledgeSearchRequest } from "./index";

const liveEnabled =
  process.env.C03_RUN_LIVE_KNOWLEDGE_TEST === "1" &&
  Boolean(process.env.DASHSCOPE_API_KEY?.trim()) &&
  Boolean(process.env.BAILIAN_WORKSPACE_ID?.trim()) &&
  Boolean(process.env.BAILIAN_KNOWLEDGE_BASE_ID?.trim()) &&
  Boolean(process.env.BAILIAN_KNOWLEDGE_SEARCH_AGENT_ID?.trim());

const fictionalRequest: KnowledgeSearchRequest = {
  contract_version: "1.0.0",
  conversation_id: "33333333-3333-4333-8333-333333333333",
  turn_id: "44444444-4444-4444-8444-444444444444",
  query: "虚构住宅装修项目中，材料和设计师档位的报价规则是什么？",
  topics: ["材料", "设计师档位"],
  filters: {},
  max_results: 5,
};

describe.skipIf(!liveEnabled)("BailianKnowledgeProvider controlled live call", () => {
  it("returns a schema-valid result without generating a quote amount", async () => {
    const provider = createBailianKnowledgeProviderFromEnv({ timeoutMs: 60_000 });

    const result = await provider.search(fictionalRequest);

    expect(KnowledgeSearchResultSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/total_amount|total_fen|quote_amount/iu);
  });
});
