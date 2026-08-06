import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  AnalysisRequestSchema,
  ChatEventSchema,
  ChatTurnResultSchema,
  ContextBundleSchema,
  CreateConversationRequestSchema,
  IdSchema,
  KnowledgeSearchRequestSchema,
  QuoteParametersSchema,
  QuoteRequestSchema,
  ReplyGenerationRequestSchema,
  SendMessageRequestSchema,
  UserMessageViewSchema,
} from "@crm-agent/contracts";
import type { ChatEvent, ChatTurnResult, ConversationStage, QuoteParameters } from "@crm-agent/contracts";
import { asApiException, conversationNotFound, invalidRequest, type ApiException } from "./errors";
import type {
  AiProvider,
  ApiLogger,
  ConversationRepository,
  KnowledgeProvider,
  MemoryService,
  QuoteService,
} from "./ports";
import {
  AI_PROVIDER,
  API_LOGGER,
  CONVERSATION_REPOSITORY,
  KNOWLEDGE_PROVIDER,
  MEMORY_SERVICE,
  QUOTE_SERVICE,
} from "./tokens";
import { transitionStage } from "./state-machine";

type ConversationSnapshot = Awaited<ReturnType<ConversationRepository["get_snapshot"]>>;

export type MessageProcessingResult =
  | { kind: "completed"; result: ChatTurnResult; events: ChatEvent[] }
  | { kind: "failed"; error: ApiException; events: ChatEvent[] };

@Injectable()
export class ConversationService {
  constructor(
    @Inject(CONVERSATION_REPOSITORY) private readonly conversations: ConversationRepository,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    @Inject(KNOWLEDGE_PROVIDER) private readonly knowledge: KnowledgeProvider,
    @Inject(MEMORY_SERVICE) private readonly memory: MemoryService,
    @Inject(QUOTE_SERVICE) private readonly quote: QuoteService,
    @Inject(API_LOGGER) private readonly logger: ApiLogger,
  ) {}

  async create(body: unknown) {
    const request = this.parseCreateRequest(body);
    const now = new Date().toISOString();
    const conversation = await this.conversations.create({
      conversation_id: randomUUID(),
      created_at: now,
      contract_version: request.contract_version,
    });
    this.logger.info("conversation.created", { conversation_id: conversation.conversation_id });
    return conversation;
  }

  async getSnapshot(conversationId: string) {
    const snapshot = await this.findSnapshot(conversationId);
    return snapshot;
  }

  async deleteLocalTestConversation(conversationId: string) {
    const id = this.parseId(conversationId);
    if (!this.isLocalTestEnvironment()) {
      throw invalidRequest("清空测试会话仅允许在 local 或 test 环境执行。");
    }
    await this.findSnapshot(id);
    await this.conversations.delete_local_test_conversation(id);
    this.logger.info("conversation.deleted", { conversation_id: id });
  }

  async submit(conversationId: string, body: unknown): Promise<MessageProcessingResult> {
    const id = this.parseId(conversationId);
    const request = this.parseSendMessageRequest(body);
    const snapshot = await this.findSnapshot(id);
    if (snapshot.contract_version !== request.contract_version) {
      throw invalidRequest("请求版本与会话版本不一致。");
    }
    if (snapshot.conversation.status === "CLOSED") {
      throw invalidRequest("已关闭会话不能继续提交消息。");
    }

    const turnId = randomUUID();
    const requestId = randomUUID();
    const emittedAt = new Date().toISOString();
    const events: ChatEvent[] = [];
    const addEvent = (eventType: ChatEvent["event_type"], payload: unknown) => {
      const event = ChatEventSchema.parse({
        contract_version: "1.0.0",
        event_id: randomUUID(),
        event_type: eventType,
        sequence: events.length + 1,
        conversation_id: id,
        turn_id: turnId,
        emitted_at: emittedAt,
        payload,
      });
      events.push(event);
    };

    addEvent("turn.accepted", { client_message_id: request.client_message_id, replayed: false });
    const userMessage = UserMessageViewSchema.parse({
      message_id: randomUUID(),
      role: "user",
      content: request.content,
      sequence: snapshot.messages.length + 1,
      created_at: emittedAt,
    });

    try {
      const context = ContextBundleSchema.parse(
        await this.memory.build_context(id, userMessage.message_id),
      );
      const analysis = await this.ai.analyze(
        AnalysisRequestSchema.parse({
          contract_version: "1.0.0",
          conversation_id: id,
          turn_id: turnId,
          current_message: userMessage,
          context,
        }),
      );
      addEvent("analysis.completed", {
        intent: analysis.intent,
        value_level: analysis.value_assessment.level,
        next_action: analysis.recommended_next_action,
      });

      const knowledgeResult = analysis.knowledge_decision.should_search
        ? await this.knowledge.search(
            KnowledgeSearchRequestSchema.parse({
              contract_version: "1.0.0",
              conversation_id: id,
              turn_id: turnId,
              query: analysis.knowledge_decision.query_hint ?? request.content,
              topics: analysis.knowledge_decision.topics,
              filters: {},
              max_results: 5,
            }),
          )
        : null;

      await this.memory.plan_mutation({
        conversation_id: id,
        turn_id: turnId,
        analysis,
        context,
      });

      const quoteOutcome =
        analysis.recommended_next_action === "prepare_quote" ||
        analysis.recommended_next_action === "adjust_quote"
          ? await this.quote.calculate(
              QuoteRequestSchema.parse({
                contract_version: "1.0.0",
                conversation_id: id,
                turn_id: turnId,
                confirmed_parameters: this.quoteParametersFromAnalysis(analysis.slot_updates),
                candidate_rule_ids: knowledgeResult?.rule_candidates.map((item) => item.rule_id) ?? [],
                knowledge_evidence_ids: knowledgeResult?.evidence.map((item) => item.evidence_id) ?? [],
                requested_at: emittedAt,
              }),
            )
          : null;

      const reply = await this.ai.compose_reply(
        ReplyGenerationRequestSchema.parse({
          contract_version: "1.0.0",
          conversation_id: id,
          turn_id: turnId,
          analysis,
          context,
          knowledge_evidence: knowledgeResult?.evidence ?? [],
          ...(quoteOutcome === null ? {} : { quote_outcome: quoteOutcome }),
        }),
      );
      const outcome = this.outcomeFor(analysis.recommended_next_action, quoteOutcome);
      const nextStage = transitionStage(snapshot.conversation.stage, analysis.stage_recommendation);
      const assistantMessage = {
        message_id: randomUUID(),
        role: "assistant" as const,
        content: reply.text,
        sequence: userMessage.sequence + 1,
        created_at: emittedAt,
        cited_evidence_ids: reply.cited_evidence_ids,
      };
      const result = ChatTurnResultSchema.parse({
        contract_version: "1.0.0",
        turn_id: turnId,
        conversation_id: id,
        client_message_id: request.client_message_id,
        status: "COMPLETED",
        outcome,
        stage: nextStage,
        user_message: userMessage,
        assistant_message: assistantMessage,
        question_fields: outcome === "question" ? reply.question_fields : [],
        quote: quoteOutcome?.kind === "quote" ? quoteOutcome.quote : null,
        warnings: quoteOutcome?.kind === "unavailable" ? [quoteOutcome.unavailable.reason] : [],
        replayed: false,
        completed_at: emittedAt,
      });

      const terminalPayload = { result };
      if (outcome === "question") {
        addEvent("question.required", {
          message: assistantMessage,
          question_fields: reply.question_fields,
        });
      } else if (outcome === "quote" && result.quote !== null) {
        addEvent("quote.ready", { message: assistantMessage, quote: result.quote });
      } else {
        addEvent("message.completed", { message: assistantMessage });
      }
      addEvent("turn.completed", terminalPayload);

      await this.conversations.save_snapshot({
        contract_version: "1.0.0",
        conversation: {
          ...snapshot.conversation,
          stage: nextStage,
          status: nextStage === "CLOSED" ? "CLOSED" : "ACTIVE",
          updated_at: emittedAt,
        },
        messages: [...snapshot.messages, userMessage, assistantMessage],
        current_quote: result.quote ?? snapshot.current_quote,
        active_turn_id: null,
      });
      this.logger.info("turn.completed", {
        request_id: requestId,
        conversation_id: id,
        turn_id: turnId,
        client_message_id: request.client_message_id,
        stage: nextStage,
        duration_ms: 0,
      });
      return { kind: "completed", result, events };
    } catch (error) {
      const apiException = asApiException(error);
      addEvent("turn.failed", { error: apiException.body.error });
      this.logger.error("turn.failed", {
        request_id: requestId,
        conversation_id: id,
        turn_id: turnId,
        client_message_id: request.client_message_id,
        error_code: apiException.body.error.code,
        duration_ms: 0,
      });
      return { kind: "failed", error: apiException, events };
    }
  }

  private async findSnapshot(conversationId: string): Promise<NonNullable<ConversationSnapshot>> {
    const snapshot = await this.conversations.get_snapshot(this.parseId(conversationId));
    if (snapshot === null) {
      throw conversationNotFound();
    }
    return snapshot;
  }

  private parseId(value: string): string {
    const parsed = IdSchema.safeParse(value);
    if (!parsed.success) {
      throw invalidRequest("会话标识不符合 UUID 格式。");
    }
    return parsed.data;
  }

  private parseCreateRequest(input: unknown): ReturnType<typeof CreateConversationRequestSchema.parse> {
    const parsed = CreateConversationRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidRequest();
    }
    return parsed.data;
  }

  private parseSendMessageRequest(input: unknown): ReturnType<typeof SendMessageRequestSchema.parse> {
    const parsed = SendMessageRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidRequest();
    }
    return parsed.data;
  }

  private isLocalTestEnvironment() {
    const environment = process.env.APP_ENV ?? "local";
    return environment === "local" || environment === "test";
  }

  private quoteParametersFromAnalysis(slotUpdates: readonly {
    slot: string;
    value: unknown;
    status: string;
  }[]): QuoteParameters {
    const confirmed = new Map(
      slotUpdates
        .filter((item) => item.status === "confirmed")
        .map((item) => [item.slot, item.value] as const),
    );
    const parsed = QuoteParametersSchema.safeParse({
      city: confirmed.get("city"),
      area_sqm: confirmed.get("area_sqm"),
      house_state: confirmed.get("house_state"),
      service_scope: confirmed.get("service_scope"),
      material_tier: confirmed.get("material_tier"),
      quantities: confirmed.get("quantities") ?? {},
      special_requirements: confirmed.get("special_requirements") ?? [],
    });
    if (!parsed.success) {
      throw invalidRequest("报价所需字段尚未全部确认。");
    }
    return parsed.data;
  }

  private outcomeFor(
    action: string,
    quoteOutcome: Awaited<ReturnType<QuoteService["calculate"]>> | null,
  ): "answer" | "question" | "quote" | "safe_stop" {
    if (action === "safe_stop") {
      return "safe_stop";
    }
    if (action === "ask_missing_fields" || quoteOutcome?.kind === "unavailable") {
      return "question";
    }
    if (quoteOutcome?.kind === "quote") {
      return "quote";
    }
    return "answer";
  }
}
