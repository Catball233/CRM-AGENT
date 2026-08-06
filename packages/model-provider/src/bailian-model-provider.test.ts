import { aiMemoryScenarioFixtures } from "@crm-agent/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  createBailianModelProviderFromEnv,
  FakeModelProvider,
  ModelProviderError,
  type ReplyDraft,
  type ReplyGenerationRequest,
} from "./index";

const fixture = aiMemoryScenarioFixtures[0]!;
const analysisRequest = fixture.analysis_request;
const analysisResult = fixture.expected_analysis;
const providerAnalysisResult = {
  ...analysisResult,
  model_metadata: {
    provider: "aliyun_bailian",
    model_id: "qwen3.7-plus",
    prompt_version: "b-02-v1",
  },
} as const;

const replyRequest: ReplyGenerationRequest = {
  contract_version: "1.0.0",
  conversation_id: analysisRequest.conversation_id,
  turn_id: analysisRequest.turn_id,
  analysis: analysisResult,
  context: analysisRequest.context,
  knowledge_evidence: [],
};

const replyDraft: ReplyDraft = {
  contract_version: "1.0.0",
  text: "可以先说明希望了解的装修范围，我会基于已确认信息继续协助。",
  cited_evidence_ids: [],
  question_fields: [],
};

const testEnv = {
  DASHSCOPE_API_KEY: "test-api-key",
  BAILIAN_MODEL_ID: "qwen3.7-plus",
};

const chatCompletionResponse = (content: string, init?: ResponseInit) =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      choices: [{ index: 0, message: { role: "assistant", content } }],
    }),
    { status: 200, ...init },
  );

const asFetch = (
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) => implementation as typeof globalThis.fetch;

describe("BailianModelProvider", () => {
  it("returns an AnalysisResult validated by the public schema", async () => {
    const fetchMock = vi.fn(
      asFetch(async () => chatCompletionResponse(JSON.stringify(analysisResult))),
    );
    const provider = createBailianModelProviderFromEnv({
      env: testEnv,
      fetch: fetchMock,
      sleep: async () => undefined,
      random: () => 0.5,
    });

    const result = await provider.analyze(analysisRequest);

    expect(result).toEqual(providerAnalysisResult);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-api-key");

    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "qwen3.7-plus",
      response_format: { type: "json_object" },
      stream: false,
      temperature: 0,
    });
    expect(body.max_tokens).toBeUndefined();
    expect(body.messages[0].content.toLowerCase()).toContain("json");
    expect(body.messages[0].content).toContain("Required JSON Schema");
  });

  it("uses the fixed Aliyun workspace host without accepting an arbitrary credential target", async () => {
    const fetchMock = vi.fn(
      asFetch(async () => chatCompletionResponse(JSON.stringify(analysisResult))),
    );
    const provider = createBailianModelProviderFromEnv({
      env: { ...testEnv, BAILIAN_WORKSPACE_ID: "workspace-123" },
      fetch: fetchMock,
      sleep: async () => undefined,
    });

    await provider.analyze(analysisRequest);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
  });

  it("reads the API key only from the supplied server environment", () => {
    expect(() => createBailianModelProviderFromEnv({ env: {} })).toThrowError(
      expect.objectContaining({
        code: "MODEL_CONFIG_INVALID",
        reason: "configuration",
        attempts: 0,
      }),
    );
    expect(() =>
      createBailianModelProviderFromEnv({
        env: { ...testEnv, BAILIAN_WORKSPACE_ID: "https://attacker.invalid" },
      }),
    ).toThrowError(expect.objectContaining({ code: "MODEL_CONFIG_INVALID" }));
  });

  it("aborts timed-out attempts and stops after the configured limit", async () => {
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
    const provider = createBailianModelProviderFromEnv({
      env: testEnv,
      fetch: fetchMock,
      timeoutMs: 5,
      maxAttempts: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      sleep: async () => undefined,
    });

    await expect(provider.analyze(analysisRequest)).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
      reason: "timeout",
      retryable: true,
      attempts: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the timeout active while the response body is being read", async () => {
    const fetchMock = vi.fn(
      asFetch(async (_input, init) => {
        const response = {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                const error = new Error("body aborted");
                error.name = "AbortError";
                reject(error);
              });
            }),
        } as Response;
        return response;
      }),
    );
    const provider = createBailianModelProviderFromEnv({
      env: testEnv,
      fetch: fetchMock,
      timeoutMs: 5,
      maxAttempts: 1,
      sleep: async () => undefined,
    });

    await expect(provider.analyze(analysisRequest)).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
      reason: "timeout",
      attempts: 1,
    });
  });

  it("retries a rate-limited call once and honors Retry-After", async () => {
    const responses = [
      new Response("", {
        status: 429,
        headers: { "Retry-After": "0.01", "X-Request-Id": "rate-limit-request" },
      }),
      chatCompletionResponse(JSON.stringify(analysisResult)),
    ];
    const fetchMock = vi.fn(asFetch(async () => responses.shift()!));
    const sleep = vi.fn(async () => undefined);
    const provider = createBailianModelProviderFromEnv({
      env: testEnv,
      fetch: fetchMock,
      maxAttempts: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 100,
      sleep,
    });

    await expect(provider.analyze(analysisRequest)).resolves.toEqual(providerAnalysisResult);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("rejects invalid JSON after two bounded validation attempts", async () => {
    const fetchMock = vi.fn(asFetch(async () => chatCompletionResponse("not-json")));
    const provider = createBailianModelProviderFromEnv({
      env: testEnv,
      fetch: fetchMock,
      maxAttempts: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      sleep: async () => undefined,
    });

    const error = await provider.analyze(analysisRequest).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({
      code: "AI_OUTPUT_INVALID",
      reason: "invalid_json",
      attempts: 2,
    });
    expect((error as Error).message).not.toContain("not-json");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects valid JSON that does not satisfy AnalysisResultSchema", async () => {
    const fetchMock = vi.fn(
      asFetch(async () => chatCompletionResponse(JSON.stringify({ contract_version: "1.0.0" }))),
    );
    const provider = createBailianModelProviderFromEnv({
      env: testEnv,
      fetch: fetchMock,
      maxAttempts: 1,
      sleep: async () => undefined,
    });

    await expect(provider.analyze(analysisRequest)).rejects.toMatchObject({
      code: "AI_OUTPUT_INVALID",
      reason: "schema_mismatch",
      attempts: 1,
    });
  });

  it("does not retry non-retryable provider authentication failures", async () => {
    const fetchMock = vi.fn(asFetch(async () => new Response("", { status: 401 })));
    const provider = createBailianModelProviderFromEnv({
      env: testEnv,
      fetch: fetchMock,
      maxAttempts: 3,
      sleep: async () => undefined,
    });

    await expect(provider.analyze(analysisRequest)).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
      reason: "provider_http",
      retryable: false,
      status: 401,
      attempts: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates structured reply output through ReplyDraftSchema", async () => {
    const fetchMock = vi.fn(asFetch(async () => chatCompletionResponse(JSON.stringify(replyDraft))));
    const provider = createBailianModelProviderFromEnv({
      env: testEnv,
      fetch: fetchMock,
      sleep: async () => undefined,
    });

    await expect(provider.compose_reply(replyRequest)).resolves.toEqual(replyDraft);
  });
});

describe("FakeModelProvider", () => {
  it("returns validated fixed responses and records cloned inputs", async () => {
    const provider = new FakeModelProvider({ analysis: analysisResult, reply: replyDraft });

    const first = await provider.analyze(analysisRequest);
    first.concerns.push({ code: "other", evidence_refs: [] });
    const second = await provider.analyze(analysisRequest);

    expect(second).toEqual(analysisResult);
    await expect(provider.compose_reply(replyRequest)).resolves.toEqual(replyDraft);
    expect(provider.analysisCalls).toHaveLength(2);
    expect(provider.replyCalls).toHaveLength(1);
  });
});
