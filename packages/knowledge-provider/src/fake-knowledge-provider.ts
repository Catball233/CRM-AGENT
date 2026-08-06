import {
  KnowledgeSearchRequestSchema,
  KnowledgeSearchResultSchema,
} from "@crm-agent/contracts";
import type {
  KnowledgeProvider,
  KnowledgeSearchRequest,
  KnowledgeSearchResult,
} from "./types";

export type FakeKnowledgeResponse =
  | KnowledgeSearchResult
  | ((input: KnowledgeSearchRequest) => KnowledgeSearchResult | Promise<KnowledgeSearchResult>);

export class FakeKnowledgeProvider implements KnowledgeProvider {
  readonly calls: KnowledgeSearchRequest[] = [];

  constructor(private readonly response: FakeKnowledgeResponse) {}

  async search(input: KnowledgeSearchRequest): Promise<KnowledgeSearchResult> {
    const validatedInput = KnowledgeSearchRequestSchema.parse(input);
    this.calls.push(structuredClone(validatedInput));

    const output =
      typeof this.response === "function"
        ? await this.response(structuredClone(validatedInput))
        : this.response;

    return structuredClone(KnowledgeSearchResultSchema.parse(output));
  }
}
