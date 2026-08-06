import {
  AnalysisRequestSchema,
  type AnalysisResult,
  ReplyDraftSchema,
  ReplyGenerationRequestSchema,
} from "@crm-agent/contracts";

export type AnalysisRequest = ReturnType<typeof AnalysisRequestSchema.parse>;
export type ReplyGenerationRequest = ReturnType<typeof ReplyGenerationRequestSchema.parse>;
export type ReplyDraft = ReturnType<typeof ReplyDraftSchema.parse>;

export interface ModelProvider {
  analyze(input: AnalysisRequest): Promise<AnalysisResult>;
  compose_reply(input: ReplyGenerationRequest): Promise<ReplyDraft>;
}

export type AiProvider = ModelProvider;

export type ModelProviderErrorCode =
  | "MODEL_CONFIG_INVALID"
  | "AI_OUTPUT_INVALID"
  | "MODEL_UNAVAILABLE";

export type ModelProviderFailureReason =
  | "configuration"
  | "timeout"
  | "rate_limited"
  | "network"
  | "provider_http"
  | "malformed_response"
  | "invalid_json"
  | "schema_mismatch";

export interface ModelProviderErrorOptions {
  code: ModelProviderErrorCode;
  reason: ModelProviderFailureReason;
  retryable: boolean;
  attempts: number;
  status?: number | undefined;
  providerRequestId?: string | undefined;
  cause?: unknown;
}

export class ModelProviderError extends Error {
  readonly code: ModelProviderErrorCode;
  readonly reason: ModelProviderFailureReason;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly status: number | undefined;
  readonly providerRequestId: string | undefined;

  constructor(message: string, options: ModelProviderErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "ModelProviderError";
    this.code = options.code;
    this.reason = options.reason;
    this.retryable = options.retryable;
    this.attempts = options.attempts;
    this.status = options.status;
    this.providerRequestId = options.providerRequestId;
  }
}
