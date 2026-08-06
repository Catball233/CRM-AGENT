import {
  AnalysisRequestSchema,
  AnalysisResultSchema,
  ReplyDraftSchema,
  ReplyGenerationRequestSchema,
} from "@crm-agent/contracts";
import type {
  AnalysisRequest,
  ModelProvider,
  ReplyDraft,
  ReplyGenerationRequest,
} from "./types";

export interface FakeModelResponses {
  analysis: unknown;
  reply: unknown;
}

export class FakeModelProvider implements ModelProvider {
  readonly analysisCalls: AnalysisRequest[] = [];
  readonly replyCalls: ReplyGenerationRequest[] = [];

  private readonly analysisResponse: ReturnType<typeof AnalysisResultSchema.parse>;
  private readonly replyResponse: ReplyDraft;

  constructor(responses: FakeModelResponses) {
    this.analysisResponse = AnalysisResultSchema.parse(responses.analysis);
    this.replyResponse = ReplyDraftSchema.parse(responses.reply);
  }

  async analyze(input: AnalysisRequest) {
    const validatedInput = AnalysisRequestSchema.parse(input);
    this.analysisCalls.push(structuredClone(validatedInput));
    return structuredClone(this.analysisResponse);
  }

  async compose_reply(input: ReplyGenerationRequest) {
    const validatedInput = ReplyGenerationRequestSchema.parse(input);
    this.replyCalls.push(structuredClone(validatedInput));
    return structuredClone(this.replyResponse);
  }
}
