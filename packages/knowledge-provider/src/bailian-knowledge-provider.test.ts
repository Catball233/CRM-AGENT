import { KnowledgeSearchResultSchema } from "@crm-agent/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createBailianKnowledgeProviderFromEnv,
  FakeKnowledgeProvider,
  KnowledgeProviderError,
  type KnowledgeSearchRequest,
  type KnowledgeSearchResult,
} from "./index";

const request: KnowledgeSearchRequest = {
  contract_version: "1.0.0",
  conversation_id: "11111111-1111-4111-8111-111111111111",
  turn_id: "22222222-2222-4222-8222-222222222222",
  query: "杭州 90 平米中档装修的材料和设计规则",
  topics: ["材料", "设计费"],
  filters: {
    city: "杭州",
    category: ["material"],
    effective_at: "2026-08-06T10:00:00+08:00",
  },
  max_results: 5,
};

const env = {
  DASHSCOPE_API_KEY: "test-api-key",
  BAILIAN_WORKSPACE_ID: "workspace-test",
  BAILIAN_KNOWLEDGE_BASE_ID: "kb-test",
  BAILIAN_KNOWLEDGE_SEARCH_AGENT_ID: "aid-test",
};

const node = (
  overrides: Record<string, unknown> = {},
  metadataOverrides: Record<string, unknown> = {},
) => ({
  score: 0.91,
  text: "rule_id: MATERIAL-MID-001\n中档材料报价规则，仅用于规则候选。",
  metadata: {
    doc_id: "doc-material-001",
    doc_name: "虚构装修报价规则.md",
    title: "中档材料规则",
    content: "rule_id: MATERIAL-MID-001\n中档材料报价规则，仅用于规则候选。",
    pipeline_id: "kb-test",
    _id: "chunk-material-001",
    category: "material",
    city: "杭州",
    effective_from: "2026-01-01T00:00:00+08:00",
    effective_to: "2026-12-31T23:59:59+08:00",
    ...metadataOverrides,
  },
  ...overrides,
});

const envelope = (nodes: unknown[], overrides: Record<string, unknown> = {}) => ({
  code: "Success",
  status_code: 200,
  status: "SUCCESS",
  success: true,
  message: "success",
  request_id: "provider-request-001",
  data: {
    total: nodes.length,
    nodes,
    cost_time: 8,
  },
  ...overrides,
});

const response = (body: unknown, init?: ResponseInit) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    ...init,
  });

const asFetch = (
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) => implementation as typeof globalThis.fetch;

describe("BailianKnowledgeProvider", () => {
  it("maps a fixed Bailian response to the frozen KnowledgeSearchResult contract", async () => {
    const fetchMock = vi.fn(asFetch(async () => response(envelope([node()]))));
    const provider = createBailianKnowledgeProviderFromEnv({
      env,
      fetch: fetchMock,
      sleep: async () => undefined,
    });

    const result = await provider.search(request);

    expect(KnowledgeSearchResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      contract_version: "1.0.0",
      provider_request_id: "provider-request-001",
      evidence: [
        {
          knowledge_base_id: "kb-test",
          document_id: "doc-material-001",
          document_version: "0.2.0",
          chunk_id: "chunk-material-001",
          score: 0.91,
          metadata: { category: "material", city: "杭州" },
          candidate_rule_ids: ["MATERIAL-MID-001"],
        },
      ],
      rule_candidates: [{ rule_id: "MATERIAL-MID-001" }],
    });
    expect(result.evidence[0]?.evidence_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://workspace-test.cn-beijing.maas.aliyuncs.com/api/v1/indices/knowledge/search",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-api-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      agent_id: "aid-test",
      query: request.query,
      images: [],
    });
  });

  it("accepts empty Bailian presentation metadata without relaxing trusted identifiers", async () => {
    const provider = createBailianKnowledgeProviderFromEnv({
      env,
      fetch: asFetch(async () => response(envelope([node({}, {
        doc_name: "",
        title: "",
        hier_title: "",
        nid: "",
      })]))),
    });

    await expect(provider.search(request)).resolves.toMatchObject({
      evidence: [{ document_id: "doc-material-001", candidate_rule_ids: ["MATERIAL-MID-001"] }],
      rule_candidates: [{ rule_id: "MATERIAL-MID-001" }],
    });
  });

  it("uses stable evidence IDs for an idempotently repeated turn", async () => {
    const fetchMock = vi.fn(asFetch(async () => response(envelope([node()]))));
    const provider = createBailianKnowledgeProviderFromEnv({ env, fetch: fetchMock });

    const first = await provider.search(request);
    const second = await provider.search(request);

    expect(first.evidence[0]?.evidence_id).toBe(second.evidence[0]?.evidence_id);
  });

  it("returns no_match for an empty provider result", async () => {
    const provider = createBailianKnowledgeProviderFromEnv({
      env,
      fetch: asFetch(async () => response(envelope([]))),
    });

    await expect(provider.search(request)).resolves.toMatchObject({
      evidence: [],
      rule_candidates: [],
      empty_reason: "no_match",
    });
  });

  it("returns below_threshold when all chunks score below the configured minimum", async () => {
    const provider = createBailianKnowledgeProviderFromEnv({
      env: { ...env, BAILIAN_MIN_SCORE: "0.8" },
      fetch: asFetch(async () => response(envelope([node({ score: 0.79 })]))),
    });

    await expect(provider.search(request)).resolves.toMatchObject({
      evidence: [],
      rule_candidates: [],
      empty_reason: "below_threshold",
    });
  });

  it("returns provider_unavailable for malformed or schema-invalid responses", async () => {
    const malformed = createBailianKnowledgeProviderFromEnv({
      env,
      fetch: asFetch(async () => response("not-json")),
    });
    const invalid = createBailianKnowledgeProviderFromEnv({
      env,
      fetch: asFetch(async () => response({ success: true })),
    });

    await expect(malformed.search(request)).resolves.toMatchObject({
      empty_reason: "provider_unavailable",
    });
    await expect(invalid.search(request)).resolves.toMatchObject({
      empty_reason: "provider_unavailable",
    });
  });

  it("aborts a timed-out request and safely returns provider_unavailable", async () => {
    const fetchMock = vi.fn(
      asFetch(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      ),
    );
    const provider = createBailianKnowledgeProviderFromEnv({
      env,
      fetch: fetchMock,
      timeoutMs: 5,
    });

    await expect(provider.search(request)).resolves.toMatchObject({
      empty_reason: "provider_unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 503])("retries HTTP %s exactly once", async (status) => {
    const responses = [
      new Response("", {
        status,
        headers: { "Retry-After": "0.01", "X-Request-Id": "first-attempt" },
      }),
      response(envelope([node()])),
    ];
    const fetchMock = vi.fn(asFetch(async () => responses.shift()!));
    const sleep = vi.fn(async () => undefined);
    const provider = createBailianKnowledgeProviderFromEnv({
      env,
      fetch: fetchMock,
      sleep,
    });

    await expect(provider.search(request)).resolves.toMatchObject({ evidence: [{ score: 0.91 }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("does not retry a non-retryable authentication failure", async () => {
    const fetchMock = vi.fn(
      asFetch(async () => new Response("", { status: 401, headers: { "X-Request-Id": "auth" } })),
    );
    const provider = createBailianKnowledgeProviderFromEnv({ env, fetch: fetchMock });

    await expect(provider.search(request)).resolves.toMatchObject({
      empty_reason: "provider_unavailable",
      provider_request_id: "auth",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses a rule candidate when different documents conflict on the same rule ID", async () => {
    const conflicting = node(
      {},
      {
        doc_id: "doc-material-conflict",
        _id: "chunk-material-conflict",
      },
    );
    const provider = createBailianKnowledgeProviderFromEnv({
      env,
      fetch: asFetch(async () => response(envelope([node(), conflicting]))),
    });

    const result = await provider.search(request);

    expect(result.evidence).toHaveLength(2);
    expect(result.rule_candidates).toEqual([]);
  });

  it("rejects an unexpected knowledge base instead of trusting cross-base evidence", async () => {
    const provider = createBailianKnowledgeProviderFromEnv({
      env,
      fetch: asFetch(async () =>
        response(envelope([node({}, { pipeline_id: "different-knowledge-base" })])),
      ),
    });

    await expect(provider.search(request)).resolves.toMatchObject({
      evidence: [],
      rule_candidates: [],
      empty_reason: "provider_unavailable",
    });
  });

  it("validates required server-only configuration", () => {
    expect(() => createBailianKnowledgeProviderFromEnv({ env: {} })).toThrowError(
      expect.objectContaining({ code: "KNOWLEDGE_CONFIG_INVALID" }),
    );
    expect(() =>
      createBailianKnowledgeProviderFromEnv({
        env: { ...env, BAILIAN_WORKSPACE_ID: "https://attacker.invalid" },
      }),
    ).toThrowError(KnowledgeProviderError);
    expect(() =>
      createBailianKnowledgeProviderFromEnv({
        env: { ...env, BAILIAN_MIN_SCORE: "1.5" },
      }),
    ).toThrowError(expect.objectContaining({ code: "KNOWLEDGE_CONFIG_INVALID" }));
  });
});

describe("FakeKnowledgeProvider", () => {
  it("validates and clones fixed results while recording validated calls", async () => {
    const fixed: KnowledgeSearchResult = {
      contract_version: "1.0.0",
      evidence: [],
      rule_candidates: [],
      empty_reason: "no_match",
    };
    const provider = new FakeKnowledgeProvider(fixed);

    const first = await provider.search(request);
    first.evidence.push({} as never);
    const second = await provider.search(request);

    expect(second).toEqual(fixed);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]).toEqual(request);
  });
});
