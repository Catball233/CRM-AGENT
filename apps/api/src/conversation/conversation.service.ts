import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  AnalysisResultSchema,
  AnalysisRequestSchema,
  ChatEventSchema,
  ChatTurnResultSchema,
  ConversationSnapshotSchema,
  ConversationViewSchema,
  ContextBundleSchema,
  CreateConversationRequestSchema,
  IdSchema,
  KnowledgeSearchResultSchema,
  KnowledgeSearchRequestSchema,
  MemoryMutationPlanSchema,
  QuoteOutcomeSchema,
  QuoteParametersSchema,
  QuoteRequestSchema,
  ReplyGenerationRequestSchema,
  ReplyDraftSchema,
  SendMessageRequestSchema,
  UserMessageViewSchema,
} from "@crm-agent/contracts";
import type {
  ChatEvent,
  ChatTurnResult,
  ContextBundle,
  ConversationStage,
  QuoteOutcome,
  QuoteParameters,
} from "@crm-agent/contracts";
import {
  asApiException,
  conversationNotFound,
  invalidAiOutput,
  invalidRequest,
  KnowledgeUnavailableError,
  PersistenceError,
  type ApiException,
} from "./errors";
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

export type ChatEventSink = (event: ChatEvent) => void | Promise<void>;

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
    const conversation = ConversationViewSchema.parse(await this.conversations.create({
      conversation_id: randomUUID(),
      created_at: now,
      contract_version: request.contract_version,
    }));
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

  responseModeFor(body: unknown): "complete" | "stream" {
    return this.parseSendMessageRequest(body).response_mode;
  }

  /** Validates request and conversation state before an SSE response is opened. */
  async validateSubmission(conversationId: string, body: unknown): Promise<void> {
    const id = this.parseId(conversationId);
    const request = this.parseSendMessageRequest(body);
    const snapshot = await this.findSnapshot(id);
    if (snapshot.contract_version !== request.contract_version) {
      throw invalidRequest("请求版本与会话版本不一致。");
    }
    if (snapshot.conversation.status === "CLOSED") {
      throw invalidRequest("已关闭会话不能继续提交消息。");
    }
  }

  async submit(
    conversationId: string,
    body: unknown,
    onEvent?: ChatEventSink,
  ): Promise<MessageProcessingResult> {
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
    const startedAt = Date.now();
    const events: ChatEvent[] = [];
    const emitEvent = async (eventType: ChatEvent["event_type"], payload: unknown) => {
      const event = ChatEventSchema.parse({
        contract_version: "1.0.0",
        event_id: randomUUID(),
        event_type: eventType,
        sequence: events.length + 1,
        conversation_id: id,
        turn_id: turnId,
        emitted_at: new Date().toISOString(),
        payload,
      });
      events.push(event);
      try {
        await onEvent?.(event);
      } catch {
        this.logger.warn("sse.write_failed", {
          conversation_id: id,
          turn_id: turnId,
          event_type: eventType,
        });
      }
    };

    await emitEvent("turn.accepted", { client_message_id: request.client_message_id, replayed: false });
    const userMessage = UserMessageViewSchema.parse({
      message_id: randomUUID(),
      role: "user",
      content: request.content,
      sequence: snapshot.messages.length + 1,
      created_at: new Date().toISOString(),
    });

    try {
      const context = ContextBundleSchema.parse(
        await this.memory.build_context(id, userMessage.message_id),
      );
      const analysis = AnalysisResultSchema.parse(
        await this.ai.analyze(
          AnalysisRequestSchema.parse({
          contract_version: "1.0.0",
          conversation_id: id,
          turn_id: turnId,
          current_message: userMessage,
          context,
          }),
        ),
      );
      await emitEvent("analysis.completed", {
        intent: analysis.intent,
        value_level: analysis.value_assessment.level,
        next_action: analysis.recommended_next_action,
      });

      if (this.mustSafelyStop(analysis)) {
        return await this.completeSafeStop(
          snapshot,
          userMessage,
          turnId,
          request.client_message_id,
          events,
          emitEvent,
        );
      }
      this.assertActionIsAllowed(analysis);
      const nextStage = this.resolveNextStage(
        snapshot.conversation.stage,
        analysis.stage_recommendation,
        id,
        turnId,
      );

      const needsQuote =
        analysis.recommended_next_action === "prepare_quote" ||
        analysis.recommended_next_action === "adjust_quote";
      if (analysis.recommended_next_action === "adjust_quote" && snapshot.current_quote === null) {
        throw invalidAiOutput("调整报价必须基于当前会话中已保存的报价版本。");
      }
      const shouldSearch = analysis.knowledge_decision.should_search || needsQuote;
      const knowledgeTopics =
        analysis.knowledge_decision.topics.length > 0 ? analysis.knowledge_decision.topics : ["quote_rule"];
      const knowledgeResult = shouldSearch
        ? KnowledgeSearchResultSchema.parse(
            await this.knowledge.search(
              KnowledgeSearchRequestSchema.parse({
              contract_version: "1.0.0",
              conversation_id: id,
              turn_id: turnId,
              query: analysis.knowledge_decision.query_hint ?? request.content,
              topics: knowledgeTopics,
              filters: {},
              max_results: 5,
              }),
            ),
          )
        : null;
      if (knowledgeResult?.empty_reason === "provider_unavailable") {
        throw new KnowledgeUnavailableError();
      }

      const memoryPlan = MemoryMutationPlanSchema.parse(
        await this.memory.plan_mutation({
          conversation_id: id,
          turn_id: turnId,
          analysis,
          context,
        }),
      );

      const candidateRuleIds = knowledgeResult?.rule_candidates.map((item) => item.rule_id) ?? [];
      const evidenceIds = knowledgeResult?.evidence.map((item) => item.evidence_id) ?? [];
      const quoteParameters = needsQuote
        ? this.quoteParametersOrUnavailable(context, analysis.slot_updates)
        : null;
      const quoteOutcome: QuoteOutcome | null = !needsQuote
        ? null
        : quoteParameters !== null && "kind" in quoteParameters
          ? quoteParameters
          : candidateRuleIds.length === 0 || evidenceIds.length === 0
            ? this.quoteUnavailable("knowledge_insufficient")
            : QuoteOutcomeSchema.parse(
                await this.quote.calculate(
                  QuoteRequestSchema.parse({
                    contract_version: "1.0.0",
                    conversation_id: id,
                    turn_id: turnId,
                    ...(analysis.recommended_next_action === "adjust_quote" && snapshot.current_quote !== null
                      ? { parent_quote_id: snapshot.current_quote.quote_id }
                      : {}),
                    confirmed_parameters: quoteParameters,
                    candidate_rule_ids: candidateRuleIds,
                    knowledge_evidence_ids: evidenceIds,
                    requested_at: new Date().toISOString(),
                  }),
                ),
              );
      this.assertQuoteReferences(
        quoteOutcome,
        id,
        candidateRuleIds,
        evidenceIds,
        analysis.recommended_next_action,
        snapshot.current_quote,
      );

      const reply = ReplyDraftSchema.parse(
        await this.ai.compose_reply(
          ReplyGenerationRequestSchema.parse({
          contract_version: "1.0.0",
          conversation_id: id,
          turn_id: turnId,
          analysis,
          context,
          knowledge_evidence: knowledgeResult?.evidence ?? [],
          ...(quoteOutcome === null ? {} : { quote_outcome: quoteOutcome }),
          }),
        ),
      );
      this.assertReplyReferences(reply.cited_evidence_ids, evidenceIds);
      const outcome = this.outcomeFor(analysis.recommended_next_action, quoteOutcome);
      const questionFields = this.questionFieldsFor(outcome, reply.question_fields, quoteOutcome);
      const assistantMessage = {
        message_id: randomUUID(),
        role: "assistant" as const,
        content: quoteOutcome?.kind === "unavailable" ? quoteOutcome.unavailable.user_safe_message : reply.text,
        sequence: userMessage.sequence + 1,
        created_at: new Date().toISOString(),
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
        question_fields: questionFields,
        quote: quoteOutcome?.kind === "quote" ? quoteOutcome.quote : null,
        warnings: quoteOutcome?.kind === "unavailable" ? [quoteOutcome.unavailable.reason] : [],
        replayed: false,
        completed_at: new Date().toISOString(),
      });

      try {
        await this.conversations.save_snapshot({
          contract_version: "1.0.0",
          conversation: {
            ...snapshot.conversation,
            stage: nextStage,
            status: nextStage === "CLOSED" ? "CLOSED" : "ACTIVE",
            updated_at: result.completed_at,
          },
          messages: [...snapshot.messages, userMessage, assistantMessage],
          current_quote: result.quote ?? snapshot.current_quote,
          active_turn_id: null,
        });
        await this.memory.apply_mutation(memoryPlan);
      } catch {
        throw new PersistenceError();
      }

      const terminalPayload = { result };
      if (outcome === "question") {
        await emitEvent("question.required", {
          message: assistantMessage,
          question_fields: questionFields,
        });
      } else if (outcome === "quote" && result.quote !== null) {
        await emitEvent("quote.ready", { message: assistantMessage, quote: result.quote });
      } else {
        await emitEvent("message.completed", { message: assistantMessage });
      }
      await emitEvent("turn.completed", terminalPayload);
      this.logger.info("turn.completed", {
        request_id: requestId,
        conversation_id: id,
        turn_id: turnId,
        client_message_id: request.client_message_id,
        stage: nextStage,
        duration_ms: Date.now() - startedAt,
      });
      return { kind: "completed", result, events };
    } catch (error) {
      const apiException = asApiException(error);
      await emitEvent("turn.failed", { error: apiException.body.error });
      this.logger.error("turn.failed", {
        request_id: requestId,
        conversation_id: id,
        turn_id: turnId,
        client_message_id: request.client_message_id,
        error_code: apiException.body.error.code,
        duration_ms: Date.now() - startedAt,
      });
      return { kind: "failed", error: apiException, events };
    }
  }

  private async findSnapshot(conversationId: string): Promise<NonNullable<ConversationSnapshot>> {
    const snapshot = await this.conversations.get_snapshot(this.parseId(conversationId));
    if (snapshot === null) {
      throw conversationNotFound();
    }
    return ConversationSnapshotSchema.parse(snapshot);
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
    const environment = process.env.APP_ENV;
    return environment === "local" || environment === "test";
  }

  private quoteParametersOrUnavailable(
    context: ContextBundle,
    slotUpdates: ReturnType<typeof AnalysisResultSchema.parse>["slot_updates"],
  ): QuoteParameters | QuoteOutcome {
    const confirmed = new Map<string, unknown>(
      context.confirmed_facts
        .filter((fact) => fact.status === "confirmed")
        .map((fact) => [fact.fact_key, fact.value] as const),
    );
    for (const update of slotUpdates) {
      if (update.status === "confirmed") {
        confirmed.set(update.slot, update.value);
      }
    }
    const required = ["city", "area_sqm", "house_state", "service_scope", "material_tier"] as const;
    const conflictingKeys = new Set(
      context.conflicted_facts
        .filter((fact) => fact.status === "conflicted")
        .map((fact) => fact.fact_key),
    );
    for (const update of slotUpdates) {
      if (update.status === "conflicted") {
        conflictingKeys.add(update.slot);
      }
    }
    const missingFields = required.filter((field) => !confirmed.has(field) || conflictingKeys.has(field));
    if (missingFields.length > 0) {
      return this.quoteUnavailable(
        "missing_fields",
        missingFields,
        "为生成预估报价，请先确认缺失或存在冲突的关键信息。",
      );
    }
    const parsed = QuoteParametersSchema.safeParse({
      city: confirmed.get("city"),
      area_sqm: confirmed.get("area_sqm"),
      house_state: confirmed.get("house_state"),
      service_scope: confirmed.get("service_scope"),
      material_tier: confirmed.get("material_tier"),
      ...(confirmed.has("designer_tier") ? { designer_tier: confirmed.get("designer_tier") } : {}),
      quantities: confirmed.get("quantities") ?? {},
      special_requirements: confirmed.get("special_requirements") ?? [],
    });
    if (!parsed.success) {
      throw invalidAiOutput("确认后的报价参数不符合契约要求。");
    }
    return parsed.data;
  }

  private outcomeFor(
    action: string,
    quoteOutcome: Awaited<ReturnType<QuoteService["calculate"]>> | null,
  ): "answer" | "question" | "quote" | "safe_stop" {
    if (action === "safe_stop" || action === "stop_sales_guidance") {
      return "safe_stop";
    }
    if (action === "ask_missing_fields" || action === "clarify_conflict") {
      return "question";
    }
    if (quoteOutcome?.kind === "unavailable") {
      return quoteOutcome.unavailable.missing_fields.length > 0 ? "question" : "answer";
    }
    if (quoteOutcome?.kind === "quote") {
      return "quote";
    }
    return "answer";
  }

  private questionFieldsFor(
    outcome: "answer" | "question" | "quote" | "safe_stop",
    replyQuestionFields: readonly string[],
    quoteOutcome: QuoteOutcome | null,
  ): string[] {
    if (outcome !== "question") {
      return [];
    }
    const fields =
      quoteOutcome?.kind === "unavailable" && quoteOutcome.unavailable.missing_fields.length > 0
        ? quoteOutcome.unavailable.missing_fields
        : replyQuestionFields;
    if (fields.length === 0) {
      throw invalidAiOutput("追问结果缺少待确认字段。");
    }
    return [...fields].slice(0, 3);
  }

  private quoteUnavailable(
    reason: "knowledge_insufficient" | "missing_fields",
    missingFields: readonly string[] = [],
    userSafeMessage = "暂时缺少有效的报价依据，无法生成预估报价。",
  ): QuoteOutcome {
    return QuoteOutcomeSchema.parse({
      kind: "unavailable",
      unavailable: {
        contract_version: "1.0.0",
        reason,
        missing_fields: missingFields,
        conflicting_rule_ids: [],
        user_safe_message: userSafeMessage,
      },
    });
  }

  private resolveNextStage(
    current: ConversationStage,
    recommended: ConversationStage,
    conversationId: string,
    turnId: string,
  ): ConversationStage {
    try {
      return transitionStage(current, recommended);
    } catch (error) {
      this.logger.warn("stage.transition.rejected", {
        conversation_id: conversationId,
        turn_id: turnId,
        stage: current,
        error_code: "INVALID_STAGE_TRANSITION",
      });
      throw error;
    }
  }

  private assertReplyReferences(citedEvidenceIds: readonly string[], evidenceIds: readonly string[]) {
    const visibleEvidence = new Set(evidenceIds);
    if (citedEvidenceIds.some((evidenceId) => !visibleEvidence.has(evidenceId))) {
      throw invalidAiOutput("回复引用了当前轮不可见的知识证据。");
    }
  }

  private assertQuoteReferences(
    quoteOutcome: QuoteOutcome | null,
    conversationId: string,
    candidateRuleIds: readonly string[],
    evidenceIds: readonly string[],
    action: string,
    currentQuote: NonNullable<ConversationSnapshot>["current_quote"],
  ) {
    if (quoteOutcome?.kind !== "quote") {
      return;
    }
    const quote = quoteOutcome.quote;
    const visibleEvidence = new Set(evidenceIds);
    const candidateRules = new Set(candidateRuleIds);
    const ruleVersionKey = (rule: { rule_id: string; rule_version_id: string; version: number }) =>
      `${rule.rule_id}:${rule.rule_version_id}:${rule.version}`;
    const quotedRuleVersions = new Set(quote.rule_versions.map(ruleVersionKey));
    if (
      quote.conversation_id !== conversationId ||
      quote.knowledge_evidence_ids.some((evidenceId) => !visibleEvidence.has(evidenceId)) ||
      quote.rule_versions.some((ruleVersion) => !candidateRules.has(ruleVersion.rule_id)) ||
      quote.items.some((item) => !quotedRuleVersions.has(ruleVersionKey(item.rule_ref)))
    ) {
      throw invalidAiOutput("报价结果引用了当前轮不可见的会话、证据或规则。");
    }
    if (action === "adjust_quote") {
      if (
        currentQuote === null ||
        quote.parent_quote_id !== currentQuote.quote_id ||
        quote.quote_version !== currentQuote.quote_version + 1
      ) {
        throw invalidAiOutput("调整报价的父版本链不符合当前会话报价状态。");
      }
      return;
    }
    if (quote.parent_quote_id !== null) {
      throw invalidAiOutput("新报价不能引用未请求的父报价版本。");
    }
  }

  private mustSafelyStop(analysis: ReturnType<typeof AnalysisResultSchema.parse>) {
    return (
      analysis.intent === "risk" ||
      analysis.recommended_next_action === "safe_stop" ||
      analysis.recommended_next_action === "stop_sales_guidance" ||
      analysis.safety_flags.some((flag) => flag.severity === "high")
    );
  }

  private assertActionIsAllowed(analysis: ReturnType<typeof AnalysisResultSchema.parse>) {
    const isQuoteAction =
      analysis.recommended_next_action === "prepare_quote" ||
      analysis.recommended_next_action === "adjust_quote";
    if (isQuoteAction && !["quote_request", "plan_adjustment", "negotiation"].includes(analysis.intent)) {
      throw invalidAiOutput("当前意图不允许执行报价动作。");
    }
  }

  private async completeSafeStop(
    snapshot: NonNullable<ConversationSnapshot>,
    userMessage: ReturnType<typeof UserMessageViewSchema.parse>,
    turnId: string,
    clientMessageId: string,
    events: ChatEvent[],
    emitEvent: (eventType: ChatEvent["event_type"], payload: unknown) => Promise<void>,
  ): Promise<MessageProcessingResult> {
    const completedAt = new Date().toISOString();
    const assistantMessage = {
      message_id: randomUUID(),
      role: "assistant" as const,
      content: "我无法协助处理该请求，但可以继续说明公开的本地测试服务范围。",
      sequence: userMessage.sequence + 1,
      created_at: completedAt,
      cited_evidence_ids: [],
    };
    const result = ChatTurnResultSchema.parse({
      contract_version: "1.0.0",
      conversation_id: snapshot.conversation.conversation_id,
      turn_id: turnId,
      client_message_id: clientMessageId,
      status: "COMPLETED",
      outcome: "safe_stop",
      stage: "CLOSED",
      user_message: userMessage,
      assistant_message: assistantMessage,
      question_fields: [],
      quote: null,
      warnings: [],
      replayed: false,
      completed_at: completedAt,
    });
    try {
      await this.conversations.save_snapshot({
        contract_version: "1.0.0",
        conversation: {
          ...snapshot.conversation,
          stage: "CLOSED",
          status: "CLOSED",
          updated_at: completedAt,
        },
        messages: [...snapshot.messages, userMessage, assistantMessage],
        current_quote: snapshot.current_quote,
        active_turn_id: null,
      });
    } catch {
      throw new PersistenceError();
    }
    await emitEvent("message.completed", { message: assistantMessage });
    await emitEvent("turn.completed", { result });
    return { kind: "completed", result, events };
  }
}
