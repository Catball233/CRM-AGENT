import type {
  ContextBundle,
  CustomerFact,
  FactCategory,
  FactKey,
  MemoryMutationPlan,
  MemorySummaryView,
  MessageView,
  QuoteSummaryView,
  SourceRef,
} from "@crm-agent/contracts";

/** applyMutationPlan 拒绝原因，用于编排器日志和测试断言 */
export type MutationRejection = {
  reason: string;
  detail: string;
};

/**
 * B-04: 假 Repository，支持独立测试。持久化能力由后续 INT-04 用
 * SQLite Repository 替换，接口不变。
 */
export interface MemoryRepository {
  listMessages(conversationId: string, limit: number): Promise<MessageView[]>;
  listFacts(conversationId: string): Promise<{
    confirmed: CustomerFact[];
    inferred: CustomerFact[];
    conflicted: CustomerFact[];
  }>;
  getLatestSummary(conversationId: string): Promise<MemorySummaryView | null>;
  getLatestQuote(conversationId: string): Promise<QuoteSummaryView | null>;
  getConversationStage(conversationId: string): Promise<ContextBundle["stage"]>;
  /**
   * 持久化 turn 的记忆变更。
   * 写入边界强制：
   * - plan.conversation_id 必须与 conversationId 一致
   * - 每个 upsert 的所有 source_refs 的 source_id 必须属于目标会话的可见消息集合
   * 返回 true=成功，false=拒绝（目标会话数据保持不变）。
   */
  applyMutationPlan(
    conversationId: string,
    plan: MemoryMutationPlan,
  ): Promise<boolean>;
}

export class InMemoryRepository implements MemoryRepository {
  private messages: Map<string, MessageView[]> = new Map();
  private facts: Map<string, CustomerFact[]> = new Map();
  private summaries: Map<string, MemorySummaryView> = new Map();
  private quotes: Map<string, QuoteSummaryView> = new Map();
  private stages: Map<string, ContextBundle["stage"]> = new Map();

  listMessages(conversationId: string, limit: number): Promise<MessageView[]> {
    const list = [...(this.messages.get(conversationId) ?? [])]
      .sort((a, b) => a.sequence - b.sequence)
      .slice(-limit);
    return Promise.resolve(list);
  }

  listFacts(conversationId: string): Promise<{
    confirmed: CustomerFact[];
    inferred: CustomerFact[];
    conflicted: CustomerFact[];
  }> {
    const facts = this.facts.get(conversationId) ?? [];
    return Promise.resolve({
      confirmed: facts.filter((f) => f.status === "confirmed"),
      inferred: facts.filter((f) => f.status === "inferred"),
      conflicted: facts.filter((f) => f.status === "conflicted"),
    });
  }

  getLatestSummary(conversationId: string): Promise<MemorySummaryView | null> {
    return Promise.resolve(this.summaries.get(conversationId) ?? null);
  }

  getLatestQuote(conversationId: string): Promise<QuoteSummaryView | null> {
    return Promise.resolve(this.quotes.get(conversationId) ?? null);
  }

  getConversationStage(conversationId: string): Promise<ContextBundle["stage"]> {
    return Promise.resolve(this.stages.get(conversationId) ?? "DISCOVERY");
  }

  applyMutationPlan(
    conversationId: string,
    plan: MemoryMutationPlan,
  ): Promise<boolean> {
    // P0 写入边界：plan.conversation_id 必须与目标会话一致
    if (plan.conversation_id !== conversationId) {
      this.lastRejection = {
        reason: "conversation_id_mismatch",
        detail: `plan=${plan.conversation_id} target=${conversationId}`,
      };
      return Promise.resolve(false);
    }

    // P0 写入边界：每个 upsert 的所有 source_refs 的 source_id 必须属于目标会话可见消息集合
    const visibleMessageIds = new Set<string>();
    for (const m of this.messages.get(conversationId) ?? []) {
      visibleMessageIds.add(m.message_id);
    }
    // summary 的 source_message_ids 也算可见
    const summary = this.summaries.get(conversationId);
    if (summary) {
      for (const mid of summary.source_message_ids) visibleMessageIds.add(mid);
    }
    // memory_summary 的 summary_id 本身合法（quote_id 同理）
    const validSummaryId = summary?.summary_id ?? null;
    const validQuoteId = this.quotes.get(conversationId)?.quote_id ?? null;

    for (const fact of plan.fact_upserts) {
      for (const ref of fact.source_refs) {
        if (!isSourceRefVisible(ref, visibleMessageIds, validSummaryId, validQuoteId)) {
          this.lastRejection = {
            reason: "foreign_source_ref",
            detail: `fact_id=${fact.fact_id} source_type=${ref.source_type} source_id=${ref.source_id}`,
          };
          return Promise.resolve(false);
        }
      }
    }

    // 所有校验通过，执行写入
    const existing = this.facts.get(conversationId) ?? [];
    const byId = new Map(existing.map((f) => [f.fact_id, { ...f }]));
    for (const f of plan.fact_upserts) byId.set(f.fact_id, { ...f });
    for (const factId of plan.fact_ids_to_mark_conflicted) {
      const f = byId.get(factId);
      if (f) (f as CustomerFact).status = "conflicted";
    }
    this.facts.set(conversationId, [...byId.values()]);
    if (plan.summary_upsert) this.summaries.set(conversationId, plan.summary_upsert);
    this.lastRejection = null;
    return Promise.resolve(true);
  }

  /** 最近一次 applyMutationPlan 的拒绝原因（null=成功或未调用） */
  lastRejection: MutationRejection | null = null;

  // —— 方便测试注入数据的 helper，不属于 Repository 接口 ——
  seedConversation(
    conversationId: string,
    stage: ContextBundle["stage"],
    messages: MessageView[],
    facts: CustomerFact[] = [],
    summary: MemorySummaryView | null = null,
    quote: QuoteSummaryView | null = null,
  ) {
    this.stages.set(conversationId, stage);
    this.messages.set(conversationId, [...messages]);
    this.facts.set(conversationId, [...facts]);
    if (summary) this.summaries.set(conversationId, summary);
    if (quote) this.quotes.set(conversationId, quote);
  }
}

export const DEFAULT_RECENT_MESSAGES_LIMIT = 20;

export const FACT_CATEGORY_FOR_KEY: Record<FactKey, FactCategory> = {
  city: "requirement",
  area_sqm: "requirement",
  layout: "requirement",
  house_state: "requirement",
  service_scope: "requirement",
  designer_tier: "preference",
  material_tier: "preference",
  budget_max_fen: "requirement",
  expected_start_date: "requirement",
  quantities: "requirement",
  special_requirements: "preference",
  preference: "preference",
  concern: "concern",
  decision_timeline: "sales_signal",
};

export type FactIdProvider = (
  conversationId: string,
  factKey: FactKey,
  primarySource: SourceRef,
  status: CustomerFact["status"],
) => string;

let counter = 0;
export const defaultFactIdProvider: FactIdProvider = (_conversationId, _factKey, _src) => {
  counter = (counter + 1) & 0xffff;
  const hex = counter.toString(16).padStart(4, "0");
  // 固定前缀 7f7f，避免与真实 UUID 冲突（UUID v4 variant 固定位 bxxxx 不会变成 b0xx）
  return `7f7f7f7f-0000-4000-8000-00000000${hex}`;
};

/**
 * 校验 source_ref 的 source_id 是否属于目标会话的可见集合。
 * - message: 必须在 visibleMessageIds 中
 * - memory_summary: 必须等于 validSummaryId
 * - quote: 必须等于 validQuoteId
 * - knowledge_chunk: 放行（知识库是全局共享的，不属于会话隔离范围）
 */
function isSourceRefVisible(
  ref: SourceRef,
  visibleMessageIds: Set<string>,
  validSummaryId: string | null,
  validQuoteId: string | null,
): boolean {
  switch (ref.source_type) {
    case "message":
      return visibleMessageIds.has(ref.source_id);
    case "memory_summary":
      return validSummaryId !== null && ref.source_id === validSummaryId;
    case "quote":
      return validQuoteId !== null && ref.source_id === validQuoteId;
    case "knowledge_chunk":
      return true;
    default:
      return false;
  }
}
