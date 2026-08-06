import {
  KnowledgeSearchRequestSchema,
  KnowledgeSearchResultSchema,
} from "@crm-agent/contracts";

export type KnowledgeSearchRequest = ReturnType<typeof KnowledgeSearchRequestSchema.parse>;
export type KnowledgeSearchResult = ReturnType<typeof KnowledgeSearchResultSchema.parse>;

export interface KnowledgeProvider {
  search(input: KnowledgeSearchRequest): Promise<KnowledgeSearchResult>;
}

export type KnowledgeProviderErrorCode =
  | "KNOWLEDGE_CONFIG_INVALID"
  | "KNOWLEDGE_REQUEST_INVALID";

export class KnowledgeProviderError extends Error {
  readonly code: KnowledgeProviderErrorCode;
  readonly retryable = false;

  constructor(code: KnowledgeProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "KnowledgeProviderError";
    this.code = code;
  }
}
