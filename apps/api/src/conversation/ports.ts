import {
  AnalysisRequestSchema,
  ConversationSnapshotSchema,
  KnowledgeSearchRequestSchema,
  ReplyDraftSchema,
  ReplyGenerationRequestSchema,
} from "@crm-agent/contracts";
import type {
  AnalysisResult,
  ChatTurnResult,
  ContextBundle,
  ConversationView,
  KnowledgeSearchResult,
  MemoryMutationPlan,
  QuoteOutcome,
  QuoteRequest,
} from "@crm-agent/contracts";

type AnalysisRequest = ReturnType<typeof AnalysisRequestSchema.parse>;
type ConversationSnapshot = ReturnType<typeof ConversationSnapshotSchema.parse>;
type KnowledgeSearchRequest = ReturnType<typeof KnowledgeSearchRequestSchema.parse>;
type ReplyDraft = ReturnType<typeof ReplyDraftSchema.parse>;
type ReplyGenerationRequest = ReturnType<typeof ReplyGenerationRequestSchema.parse>;

export type SupportedContractVersion = "1.0.0";

export interface CreateConversationInput {
  conversation_id: string;
  created_at: string;
  contract_version: SupportedContractVersion;
}

/**
 * A private persistence boundary for A-03.  The in-memory implementation is
 * deliberately replaceable by the SQLite repository work in a later task.
 */
export interface ConversationRepository {
  create(input: CreateConversationInput): Promise<ConversationView>;
  get_snapshot(conversationId: string): Promise<ConversationSnapshot | null>;
  save_snapshot(snapshot: ConversationSnapshot): Promise<void>;
  delete_local_test_conversation(conversationId: string): Promise<void>;
}

export interface AiProvider {
  analyze(input: AnalysisRequest): Promise<AnalysisResult>;
  compose_reply(input: ReplyGenerationRequest): Promise<ReplyDraft>;
}

export interface KnowledgeProvider {
  search(input: KnowledgeSearchRequest): Promise<KnowledgeSearchResult>;
}

export interface MemoryService {
  build_context(conversationId: string, currentMessageId: string): Promise<ContextBundle>;
  plan_mutation(input: {
    conversation_id: string;
    turn_id: string;
    analysis: AnalysisResult;
    context: ContextBundle;
  }): Promise<MemoryMutationPlan>;
  /** Applies a previously validated plan after the conversation result is durable. */
  apply_mutation(plan: MemoryMutationPlan): Promise<void>;
}

export interface QuoteService {
  calculate(input: QuoteRequest): Promise<QuoteOutcome>;
}

/** Deliberately excludes customer text, knowledge excerpts, secrets and paths. */
export interface ApiLogFields {
  request_id?: string;
  conversation_id?: string;
  turn_id?: string;
  client_message_id?: string;
  event_type?: string;
  stage?: string;
  error_code?: string;
  duration_ms?: number;
}

export interface ApiLogger {
  info(event: string, fields: ApiLogFields): void;
  warn(event: string, fields: ApiLogFields): void;
  error(event: string, fields: ApiLogFields): void;
}

/** Reserved for the A-04 persistence implementation. */
export interface CompletedTurnStore {
  result: ChatTurnResult;
}
