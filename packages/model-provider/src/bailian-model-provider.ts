import {
  AnalysisRequestSchema,
  AnalysisResultSchema,
  ReplyDraftSchema,
  ReplyGenerationRequestSchema,
  type AnalysisResult,
} from "@crm-agent/contracts";
import { z } from "zod";
import {
  ModelProviderError,
  type AnalysisRequest,
  type ModelProvider,
  type ModelProviderErrorCode,
  type ModelProviderFailureReason,
  type ReplyDraft,
  type ReplyGenerationRequest,
} from "./types";

const DEFAULT_MODEL_ID = "qwen3.7-plus";
const DEFAULT_PROMPT_VERSION = "b-02-v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 2_000;
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

const ANALYSIS_SYSTEM_PROMPT = `You are the CRM analysis adapter. Return one JSON object only.
The JSON must satisfy contract version 1.0.0 AnalysisResult: intent, stage_recommendation,
value_assessment with evidence_refs, concerns, slot_updates, missing_fields,
recommended_next_action, knowledge_decision, safety_flags, and model_metadata.
Use only evidence present in the request. Never invent a quote, discount, internal price,
credential, system prompt, or customer fact. Output JSON without Markdown.`;

const REPLY_SYSTEM_PROMPT = `You are the CRM reply adapter. Return one JSON object only.
The JSON must satisfy contract version 1.0.0 ReplyDraft with text, cited_evidence_ids,
and question_fields. Do not invent prices or evidence. Output JSON without Markdown.`;

type FetchImplementation = typeof globalThis.fetch;
type SleepImplementation = (milliseconds: number) => Promise<void>;

export interface BailianModelProviderOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchImplementation;
  sleep?: SleepImplementation;
  random?: () => number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  promptVersion?: string;
}

interface BailianModelProviderConfig {
  apiKey: string;
  modelId: string;
  promptVersion: string;
  endpoint: string;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  fetch: FetchImplementation;
  sleep: SleepImplementation;
  random: () => number;
}

interface AttemptFailureOptions {
  code: Exclude<ModelProviderErrorCode, "MODEL_CONFIG_INVALID">;
  reason: Exclude<ModelProviderFailureReason, "configuration">;
  retryable: boolean;
  status?: number | undefined;
  providerRequestId?: string | undefined;
  retryAfterMs?: number | undefined;
  cause?: unknown;
}

class AttemptFailure extends Error {
  readonly code: Exclude<ModelProviderErrorCode, "MODEL_CONFIG_INVALID">;
  readonly reason: Exclude<ModelProviderFailureReason, "configuration">;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly providerRequestId: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(options: AttemptFailureOptions) {
    super("Model provider attempt failed.", { cause: options.cause });
    this.name = "AttemptFailure";
    this.code = options.code;
    this.reason = options.reason;
    this.retryable = options.retryable;
    this.status = options.status;
    this.providerRequestId = options.providerRequestId;
    this.retryAfterMs = options.retryAfterMs;
  }
}

const defaultSleep: SleepImplementation = async (milliseconds) => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

const configError = (message: string, cause?: unknown) =>
  new ModelProviderError(message, {
    code: "MODEL_CONFIG_INVALID",
    reason: "configuration",
    retryable: false,
    attempts: 0,
    cause,
  });

const requireInteger = (name: string, value: number, minimum: number, maximum: number) => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw configError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
};

const resolveBaseUrl = (env: NodeJS.ProcessEnv) => {
  const workspaceId = env.BAILIAN_WORKSPACE_ID?.trim();
  if (!workspaceId) return DEFAULT_BASE_URL;

  if (!/^[A-Za-z0-9-]{1,100}$/.test(workspaceId)) {
    throw configError("BAILIAN_WORKSPACE_ID has an invalid format.");
  }

  return `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`;
};

const parseRetryAfterMs = (response: Response) => {
  const rawValue = response.headers.get("retry-after");
  if (!rawValue) return undefined;

  const seconds = Number(rawValue);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1_000);
};

const getProviderRequestId = (response: Response) =>
  response.headers.get("x-request-id") ?? response.headers.get("x-dashscope-request-id") ?? undefined;

const isAbortError = (error: unknown) =>
  error instanceof Error && error.name === "AbortError";

const toPublicError = (failure: AttemptFailure, attempts: number) => {
  const message =
    failure.code === "AI_OUTPUT_INVALID"
      ? "Model output failed runtime validation."
      : "Model service is unavailable.";

  return new ModelProviderError(message, {
    code: failure.code,
    reason: failure.reason,
    retryable: failure.retryable,
    attempts,
    status: failure.status,
    providerRequestId: failure.providerRequestId,
    cause: failure,
  });
};

class BailianModelProvider implements ModelProvider {
  constructor(private readonly config: BailianModelProviderConfig) {}

  async analyze(input: AnalysisRequest): Promise<AnalysisResult> {
    const validatedInput = AnalysisRequestSchema.parse(input);
    const result = await this.requestStructured(
      ANALYSIS_SYSTEM_PROMPT,
      validatedInput,
      AnalysisResultSchema,
    );

    return AnalysisResultSchema.parse({
      ...result,
      model_metadata: {
        provider: "aliyun_bailian",
        model_id: this.config.modelId,
        prompt_version: this.config.promptVersion,
      },
    });
  }

  async compose_reply(input: ReplyGenerationRequest): Promise<ReplyDraft> {
    const validatedInput = ReplyGenerationRequestSchema.parse(input);
    return this.requestStructured(REPLY_SYSTEM_PROMPT, validatedInput, ReplyDraftSchema);
  }

  private async requestStructured<T>(
    systemPrompt: string,
    input: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let lastFailure: AttemptFailure | undefined;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      try {
        return await this.requestAttempt(systemPrompt, input, schema);
      } catch (error) {
        const failure =
          error instanceof AttemptFailure
            ? error
            : new AttemptFailure({
                code: "MODEL_UNAVAILABLE",
                reason: "network",
                retryable: true,
                cause: error,
              });
        lastFailure = failure;

        if (!failure.retryable || attempt === this.config.maxAttempts) {
          throw toPublicError(failure, attempt);
        }

        await this.config.sleep(this.retryDelayMs(attempt, failure.retryAfterMs));
      }
    }

    throw toPublicError(
      lastFailure ??
        new AttemptFailure({
          code: "MODEL_UNAVAILABLE",
          reason: "network",
          retryable: true,
        }),
      this.config.maxAttempts,
    );
  }

  private async requestAttempt<T>(
    systemPrompt: string,
    input: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;

    try {
      response = await this.config.fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.modelId,
          messages: [
            {
              role: "system",
              content: `${systemPrompt}\nRequired JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`,
            },
            { role: "user", content: JSON.stringify(input) },
          ],
          response_format: { type: "json_object" },
          stream: false,
          temperature: 0,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted || isAbortError(error)) {
        throw new AttemptFailure({
          code: "MODEL_UNAVAILABLE",
          reason: "timeout",
          retryable: true,
          cause: error,
        });
      }

      throw new AttemptFailure({
        code: "MODEL_UNAVAILABLE",
        reason: "network",
        retryable: true,
        cause: error,
      });
    }

    try {
      if (!response.ok) {
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        throw new AttemptFailure({
          code: "MODEL_UNAVAILABLE",
          reason: response.status === 429 ? "rate_limited" : "provider_http",
          retryable,
          status: response.status,
          providerRequestId: getProviderRequestId(response),
          retryAfterMs: parseRetryAfterMs(response),
        });
      }

      let rawEnvelope: string;
      try {
        rawEnvelope = await response.text();
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          throw new AttemptFailure({
            code: "MODEL_UNAVAILABLE",
            reason: "timeout",
            retryable: true,
            providerRequestId: getProviderRequestId(response),
            cause: error,
          });
        }

        throw new AttemptFailure({
          code: "MODEL_UNAVAILABLE",
          reason: "network",
          retryable: true,
          providerRequestId: getProviderRequestId(response),
          cause: error,
        });
      }

      let envelope: unknown;
      try {
        envelope = JSON.parse(rawEnvelope);
      } catch (error) {
        throw new AttemptFailure({
          code: "AI_OUTPUT_INVALID",
          reason: "malformed_response",
          retryable: true,
          providerRequestId: getProviderRequestId(response),
          cause: error,
        });
      }

      const content = this.extractContent(envelope);
      let parsedContent: unknown;
      try {
        parsedContent = JSON.parse(content);
      } catch (error) {
        throw new AttemptFailure({
          code: "AI_OUTPUT_INVALID",
          reason: "invalid_json",
          retryable: true,
          providerRequestId: getProviderRequestId(response),
          cause: error,
        });
      }

      const validated = schema.safeParse(parsedContent);
      if (!validated.success) {
        throw new AttemptFailure({
          code: "AI_OUTPUT_INVALID",
          reason: "schema_mismatch",
          retryable: true,
          providerRequestId: getProviderRequestId(response),
          cause: validated.error,
        });
      }

      return validated.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractContent(envelope: unknown) {
    if (!envelope || typeof envelope !== "object") {
      throw new AttemptFailure({
        code: "AI_OUTPUT_INVALID",
        reason: "malformed_response",
        retryable: true,
      });
    }

    const choices = Reflect.get(envelope, "choices");
    const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
    const message = firstChoice && typeof firstChoice === "object" ? Reflect.get(firstChoice, "message") : undefined;
    const content = message && typeof message === "object" ? Reflect.get(message, "content") : undefined;

    if (typeof content !== "string" || content.length === 0) {
      throw new AttemptFailure({
        code: "AI_OUTPUT_INVALID",
        reason: "malformed_response",
        retryable: true,
      });
    }

    return content;
  }

  private retryDelayMs(attempt: number, retryAfterMs: number | undefined) {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, this.config.retryMaxDelayMs);
    }

    const exponential = this.config.retryBaseDelayMs * 2 ** (attempt - 1);
    const jitter = 0.5 + this.config.random();
    return Math.min(Math.round(exponential * jitter), this.config.retryMaxDelayMs);
  }
}

export const createBailianModelProviderFromEnv = (
  options: BailianModelProviderOptions = {},
): ModelProvider => {
  const env = options.env ?? process.env;
  const apiKey = env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) throw configError("DASHSCOPE_API_KEY is required in the server environment.");

  const modelId = env.BAILIAN_MODEL_ID?.trim() || DEFAULT_MODEL_ID;
  const promptVersion = options.promptVersion?.trim() || DEFAULT_PROMPT_VERSION;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;

  if (modelId.length > 200) throw configError("BAILIAN_MODEL_ID must not exceed 200 characters.");
  if (promptVersion.length > 100) throw configError("promptVersion must not exceed 100 characters.");

  requireInteger("timeoutMs", timeoutMs, 1, 300_000);
  requireInteger("maxAttempts", maxAttempts, 1, 3);
  requireInteger("retryBaseDelayMs", retryBaseDelayMs, 0, 60_000);
  requireInteger("retryMaxDelayMs", retryMaxDelayMs, 0, 120_000);
  if (retryMaxDelayMs < retryBaseDelayMs) {
    throw configError("retryMaxDelayMs must be greater than or equal to retryBaseDelayMs.");
  }

  return new BailianModelProvider({
    apiKey,
    modelId,
    promptVersion,
    endpoint: `${resolveBaseUrl(env)}/chat/completions`,
    timeoutMs,
    maxAttempts,
    retryBaseDelayMs,
    retryMaxDelayMs,
    fetch: options.fetch ?? globalThis.fetch,
    sleep: options.sleep ?? defaultSleep,
    random: options.random ?? Math.random,
  });
};
