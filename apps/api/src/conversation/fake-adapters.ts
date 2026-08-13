import { randomUUID } from "node:crypto";
import {
  AnalysisRequestSchema,
  AnalysisResultSchema,
  ContextBundleSchema,
  CONTRACT_VERSION,
  ConversationSnapshotSchema,
  ConversationViewSchema,
  CustomerFactSchema,
  IdSchema,
  KnowledgeSearchRequestSchema,
  KnowledgeSearchResultSchema,
  MemoryMutationPlanSchema,
  QuoteOutcomeSchema,
  QuoteRequestSchema,
  ReplyDraftSchema,
  ReplyGenerationRequestSchema,
} from "@crm-agent/contracts";
import type {
  AiProvider,
  ApiLogFields,
  ApiLogger,
  ConversationRepository,
  CreateConversationInput,
  KnowledgeProvider,
  MemoryService,
  QuoteService,
} from "./ports";
import { ModelUnavailableError } from "./errors";

const LOCAL_TEST_CONTRACT_VERSION = CONTRACT_VERSION;
interface StoredConversation {
  contract_version: typeof LOCAL_TEST_CONTRACT_VERSION;
  snapshot: ReturnType<typeof ConversationSnapshotSchema.parse>;
}

export class FakeConversationRepository implements ConversationRepository {
  private readonly conversations = new Map<string, StoredConversation>();

  async create(input: CreateConversationInput) {
    const conversationId = IdSchema.parse(input.conversation_id);
    if (input.contract_version !== LOCAL_TEST_CONTRACT_VERSION) {
      throw new Error("Unsupported contract version for local fake repository");
    }

    const conversation = ConversationViewSchema.parse({
      contract_version: LOCAL_TEST_CONTRACT_VERSION,
      conversation_id: conversationId,
      stage: "DISCOVERY",
      status: "ACTIVE",
      created_at: input.created_at,
      updated_at: input.created_at,
    });
    const snapshot = ConversationSnapshotSchema.parse({
      contract_version: LOCAL_TEST_CONTRACT_VERSION,
      conversation,
      messages: [],
      current_quote: null,
      active_turn_id: null,
    });

    this.conversations.set(conversationId, {
      contract_version: LOCAL_TEST_CONTRACT_VERSION,
      snapshot,
    });
    return conversation;
  }

  async get_snapshot(conversationId: string) {
    const record = this.conversations.get(IdSchema.parse(conversationId));
    return record === undefined ? null : ConversationSnapshotSchema.parse(record.snapshot);
  }

  async save_snapshot(snapshot: ReturnType<typeof ConversationSnapshotSchema.parse>) {
    const parsed = ConversationSnapshotSchema.parse(snapshot);
    const record = this.conversations.get(parsed.conversation.conversation_id);
    if (record === undefined) {
      throw new Error("Cannot save a snapshot for an unknown conversation");
    }
    if (record.contract_version !== parsed.contract_version) {
      throw new Error("Conversation contract version is immutable");
    }
    this.conversations.set(parsed.conversation.conversation_id, {
      contract_version: record.contract_version,
      snapshot: parsed,
    });
  }

  async delete_local_test_conversation(conversationId: string) {
    this.conversations.delete(IdSchema.parse(conversationId));
  }
}

export class FakeAiProvider implements AiProvider {
  async analyze(input: Parameters<AiProvider["analyze"]>[0]) {
    const request = AnalysisRequestSchema.parse(input);
    const source = { source_type: "message" as const, source_id: request.current_message.message_id };
    const content = request.current_message.content;
    if (/模拟慢模型/u.test(content)) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (/模拟模型失败/u.test(content)) {
      throw new ModelUnavailableError();
    }
    const isRiskRequest = /(提示词|密钥|底价|忽略.*规则)/u.test(content);
    const isCompleteQuoteRequest = /(完整报价|可报价)/u.test(content);
    const isQuoteRequest = /(报价|估价|预算|多少钱)/u.test(content);
    const isPublicFaqQuestion = /(流程|区别|风险|边界|包含哪些|什么时候)/u.test(content);

    return AnalysisResultSchema.parse(
      isRiskRequest
        ? {
            contract_version: LOCAL_TEST_CONTRACT_VERSION,
            intent: "risk",
            stage_recommendation: "CLOSED",
            value_assessment: { level: "unknown", evidence_refs: [], reason_codes: ["safety_boundary"] },
            concerns: [],
            slot_updates: [],
            missing_fields: [],
            recommended_next_action: "safe_stop",
            knowledge_decision: { should_search: false, reason_codes: ["safety_boundary"], topics: [] },
            safety_flags: [
              {
                code: "secret_request",
                severity: "high",
                evidence_refs: [{ ...source, excerpt: content.slice(0, 100) }],
              },
            ],
            model_metadata: {
              provider: "aliyun_bailian",
              model_id: "fake-model-v1",
              prompt_version: "fake-analysis-v1",
            },
          }
        : isQuoteRequest && isPublicFaqQuestion
          ? {
              contract_version: LOCAL_TEST_CONTRACT_VERSION,
              intent: "unclear",
              stage_recommendation: request.context.stage,
              value_assessment: { level: "unknown", evidence_refs: [], reason_codes: ["mixed_intent_human_handoff"] },
              concerns: [],
              slot_updates: [],
              missing_fields: [],
              recommended_next_action: "stop_sales_guidance",
              knowledge_decision: { should_search: false, reason_codes: ["mixed_intent_human_handoff"], topics: [] },
              safety_flags: [],
              model_metadata: {
                provider: "aliyun_bailian",
                model_id: "fake-model-v1",
                prompt_version: "fake-analysis-v1",
              },
            }
          : isCompleteQuoteRequest
          ? {
              contract_version: LOCAL_TEST_CONTRACT_VERSION,
              intent: "quote_request",
              stage_recommendation: this.quoteStageFor(request.context.stage),
              value_assessment: {
                level: "medium",
                evidence_refs: [{ ...source, excerpt: content.slice(0, 100) }],
                reason_codes: ["complete_quote_request"],
              },
              concerns: [],
              slot_updates: [
                { slot: "city", value: "默认测试城市", status: "confirmed", source_refs: [source] },
                { slot: "area_sqm", value: 90, status: "confirmed", source_refs: [source] },
                { slot: "house_state", value: "old_renovation", status: "confirmed", source_refs: [source] },
                { slot: "service_scope", value: "whole_home", status: "confirmed", source_refs: [source] },
                { slot: "material_tier", value: "mid", status: "confirmed", source_refs: [source] },
              ],
              missing_fields: [],
              recommended_next_action: "prepare_quote",
              knowledge_decision: {
                should_search: false,
                reason_codes: ["local_quote_rule_lookup"],
                topics: [],
              },
              safety_flags: [],
              model_metadata: {
                provider: "aliyun_bailian",
                model_id: "fake-model-v1",
                prompt_version: "fake-analysis-v1",
              },
            }
          : isQuoteRequest
          ? {
              contract_version: LOCAL_TEST_CONTRACT_VERSION,
              intent: "quote_request",
              stage_recommendation: this.missingFieldStageFor(request.context.stage),
              value_assessment: {
                level: "medium",
                evidence_refs: [{ ...source, excerpt: content.slice(0, 100) }],
                reason_codes: ["explicit_quote_request"],
              },
              concerns: [],
              slot_updates: [],
              missing_fields: [{ slot: "city", reason: "报价前需要确认服务地区", priority: 1 }],
              recommended_next_action: "ask_missing_fields",
              knowledge_decision: { should_search: false, reason_codes: ["missing_city"], topics: [] },
              safety_flags: [],
              model_metadata: {
                provider: "aliyun_bailian",
                model_id: "fake-model-v1",
                prompt_version: "fake-analysis-v1",
              },
            }
          : {
              contract_version: LOCAL_TEST_CONTRACT_VERSION,
              intent: "consulting",
              stage_recommendation: "DISCOVERY",
              value_assessment: {
                level: "low",
                evidence_refs: [{ ...source, excerpt: content.slice(0, 100) }],
                reason_codes: ["service_consulting"],
              },
              concerns: [],
              slot_updates: [],
              missing_fields: [],
              recommended_next_action: "search_knowledge",
              knowledge_decision: {
                should_search: true,
                reason_codes: ["service_question"],
                topics: ["local_mvp_service"],
                query_hint: content.slice(0, 200),
              },
              safety_flags: [],
              model_metadata: {
                provider: "aliyun_bailian",
                model_id: "fake-model-v1",
                prompt_version: "fake-analysis-v1",
              },
            },
    );
  }

  async compose_reply(input: Parameters<AiProvider["compose_reply"]>[0]) {
    const request = ReplyGenerationRequestSchema.parse(input);
    const isSafeStop = request.analysis.recommended_next_action === "safe_stop";
    const isQuestion =
      request.analysis.recommended_next_action === "ask_missing_fields" ||
      request.analysis.recommended_next_action === "clarify_conflict";
    const unavailable = request.quote_outcome?.kind === "unavailable" ? request.quote_outcome.unavailable : null;

    return ReplyDraftSchema.parse({
      contract_version: LOCAL_TEST_CONTRACT_VERSION,
      text: isSafeStop
        ? "我无法提供内部信息或底价，但可以继续说明公开的本地测试服务范围。"
        : unavailable !== null
          ? unavailable.user_safe_message
        : isQuestion
          ? "为提供本地测试预估，请先确认服务地区。"
          : "这是本地测试回复；如需继续，请补充您的装修需求。",
      cited_evidence_ids: [],
      question_fields: isQuestion ? request.analysis.missing_fields.map((field) => field.slot).slice(0, 3) : [],
    });
  }

  private quoteStageFor(current: ReturnType<typeof ContextBundleSchema.parse>["stage"]) {
    switch (current) {
      case "DISCOVERY":
        return "QUALIFYING" as const;
      case "QUALIFYING":
        return "QUOTING" as const;
      case "QUOTING":
        return "NEGOTIATION" as const;
      case "NEGOTIATION":
        return "QUOTING" as const;
      case "COMPLETED":
        return "NEGOTIATION" as const;
      case "CLOSED":
        return "CLOSED" as const;
    }
  }

  private missingFieldStageFor(current: ReturnType<typeof ContextBundleSchema.parse>["stage"]) {
    switch (current) {
      case "DISCOVERY":
      case "QUALIFYING":
      case "QUOTING":
        return "QUALIFYING" as const;
      case "NEGOTIATION":
        return "NEGOTIATION" as const;
      case "COMPLETED":
        return "NEGOTIATION" as const;
      case "CLOSED":
        return "CLOSED" as const;
    }
  }
}

export class FakeKnowledgeProvider implements KnowledgeProvider {
  async search(input: Parameters<KnowledgeProvider["search"]>[0]) {
    const request = KnowledgeSearchRequestSchema.parse(input);
    return KnowledgeSearchResultSchema.parse({
      contract_version: LOCAL_TEST_CONTRACT_VERSION,
      evidence: [
        {
          contract_version: LOCAL_TEST_CONTRACT_VERSION,
          evidence_id: request.turn_id,
          knowledge_base_id: "fake-knowledge-base",
          document_id: "fake-rule-document",
          document_version: "1.0.0",
          chunk_id: "fake-chunk-001",
          title: "本地测试知识条目",
          excerpt: "仅用于 A-03 API 集成测试。",
          score: 1,
          metadata: {},
          candidate_rule_ids: ["RULE-FAKE-001"],
        },
      ],
      rule_candidates: [{ rule_id: "RULE-FAKE-001", evidence_id: request.turn_id }],
      provider_request_id: `fake-knowledge-${request.turn_id}`,
    });
  }
}

export class FakeMemoryService implements MemoryService {
  private readonly factsByConversation = new Map<string, ReturnType<typeof CustomerFactSchema.parse>[]>();

  constructor(private readonly conversations?: Pick<ConversationRepository, "get_snapshot">) {}

  async build_context(conversationId: string, currentMessageId: string) {
    const parsedConversationId = IdSchema.parse(conversationId);
    IdSchema.parse(currentMessageId);
    const snapshot = await this.conversations?.get_snapshot(parsedConversationId);
    const currentQuote = snapshot?.current_quote ?? null;
    const facts = this.factsByConversation.get(parsedConversationId) ?? [];
    return ContextBundleSchema.parse({
      contract_version: LOCAL_TEST_CONTRACT_VERSION,
      conversation_id: parsedConversationId,
      stage: snapshot?.conversation.stage ?? "DISCOVERY",
      recent_messages: snapshot?.messages.slice(-20) ?? [],
      confirmed_facts: facts.filter((fact) => fact.status === "confirmed"),
      inferred_facts: facts.filter((fact) => fact.status === "inferred"),
      conflicted_facts: facts.filter((fact) => fact.status === "conflicted"),
      memory_summary: null,
      current_quote:
        currentQuote === null
          ? null
          : {
              quote_id: currentQuote.quote_id,
              quote_version: currentQuote.quote_version,
              estimated_total_fen: currentQuote.estimated_total_fen,
              ...(currentQuote.parameters_snapshot.material_tier === undefined
                ? {}
                : { material_tier: currentQuote.parameters_snapshot.material_tier }),
              ...(currentQuote.parameters_snapshot.designer_tier === undefined
                ? {}
                : { designer_tier: currentQuote.parameters_snapshot.designer_tier }),
              created_at: currentQuote.created_at,
            },
      recalled_items: [],
      built_at: new Date().toISOString(),
    });
  }

  async plan_mutation(input: Parameters<MemoryService["plan_mutation"]>[0]) {
    const conversationId = IdSchema.parse(input.conversation_id);
    const turnId = IdSchema.parse(input.turn_id);
    const analysis = AnalysisResultSchema.parse(input.analysis);
    const context = ContextBundleSchema.parse(input.context);
    if (context.conversation_id !== conversationId) {
      throw new Error("Memory context belongs to another conversation");
    }
    const factUpserts = analysis.slot_updates.map((update) =>
        CustomerFactSchema.parse({
          fact_id: randomUUID(),
          fact_key: update.slot,
          category: "requirement",
          value: update.value,
          status: update.status,
          source_refs: update.source_refs,
          updated_at: new Date().toISOString(),
        }),
      );
    const factIdsToMarkConflicted = analysis.slot_updates
      .filter((update) => update.status === "conflicted")
      .flatMap((update) =>
        update.conflicts_with_fact_ids ?? context.confirmed_facts
          .filter((fact) => fact.fact_key === update.slot)
          .map((fact) => fact.fact_id),
      );
    return MemoryMutationPlanSchema.parse({
      contract_version: LOCAL_TEST_CONTRACT_VERSION,
      conversation_id: conversationId,
      turn_id: turnId,
      fact_upserts: factUpserts,
      fact_ids_to_mark_conflicted: [...new Set(factIdsToMarkConflicted)],
      summary_upsert: null,
    });
  }

  async apply_mutation(input: Parameters<MemoryService["apply_mutation"]>[0]) {
    const plan = MemoryMutationPlanSchema.parse(input);
    const conflictedIds = new Set(plan.fact_ids_to_mark_conflicted);
    let facts = (this.factsByConversation.get(plan.conversation_id) ?? []).map((fact) =>
      conflictedIds.has(fact.fact_id) ? { ...fact, status: "conflicted" as const } : fact,
    );
    for (const fact of plan.fact_upserts) {
      if (fact.status === "confirmed") {
        facts = facts.filter((existing) => existing.fact_key !== fact.fact_key);
      }
      facts.push(fact);
    }
    this.factsByConversation.set(plan.conversation_id, facts);
  }
}

export class FakeQuoteService implements QuoteService {
  private readonly versionsByQuoteId = new Map<string, number>();

  async calculate(input: Parameters<QuoteService["calculate"]>[0]) {
    const request = QuoteRequestSchema.parse(input);
    const amountFen = 1_000_000;
    const ruleId = request.candidate_rule_ids[0] ?? "RULE-LOCAL-FAKE-001";

    const quoteVersion = request.parent_quote_id === undefined
      ? 1
      : (this.versionsByQuoteId.get(request.parent_quote_id) ?? 0) + 1;
    const outcome = QuoteOutcomeSchema.parse({
      kind: "quote",
      quote: {
        contract_version: LOCAL_TEST_CONTRACT_VERSION,
        quote_id: request.turn_id,
        conversation_id: request.conversation_id,
        quote_version: quoteVersion,
        parent_quote_id: request.parent_quote_id ?? null,
        status: "estimated",
        currency: "CNY",
        parameters_snapshot: request.confirmed_parameters,
        items: [
          {
            quote_item_id: request.turn_id,
            category: "construction",
            label: "本地测试报价项",
            calculation_type: "FIXED_AMOUNT",
            amount_fen: amountFen,
            calculation_inputs: { fixture: true },
            rule_ref: { rule_id: ruleId, rule_version_id: request.conversation_id, version: 1 },
          },
        ],
        estimated_total_fen: amountFen,
        rule_versions: [{ rule_id: ruleId, rule_version_id: request.conversation_id, version: 1 }],
        knowledge_evidence_ids: request.knowledge_evidence_ids,
        assumptions: ["仅用于本地测试"],
        exclusions: ["不包含正式量房后的变更"],
        disclaimer: "本结果为本地测试预估，不构成正式报价。",
        created_at: request.requested_at,
      },
    });
    if (outcome.kind === "quote") {
      this.versionsByQuoteId.set(outcome.quote.quote_id, outcome.quote.quote_version);
    }
    return outcome;
  }
}

export interface FakeLogRecord {
  level: "info" | "warn" | "error";
  event: string;
  fields: ApiLogFields;
}

export class FakeApiLogger implements ApiLogger {
  readonly records: FakeLogRecord[] = [];

  info(event: string, fields: ApiLogFields) {
    this.records.push({ level: "info", event, fields: { ...fields } });
  }

  warn(event: string, fields: ApiLogFields) {
    this.records.push({ level: "warn", event, fields: { ...fields } });
  }

  error(event: string, fields: ApiLogFields) {
    this.records.push({ level: "error", event, fields: { ...fields } });
  }
}
