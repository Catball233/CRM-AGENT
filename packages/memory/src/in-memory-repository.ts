import type {
  ContextBundle,
  CustomerFact,
  FactCategory,
  FactKey,
  MemorySummaryView,
  MessageView,
  QuoteSummaryView,
  SourceRef,
} from "@crm-agent/contracts";

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
  /** 持久化 turn 的记忆变更。返回 true 表示成功保存。 */
  applyMutationPlan(
    conversationId: string,
    plan: {
      factUpserts: CustomerFact[];
      factIdsToMarkConflicted: string[];
      summaryUpsert: MemorySummaryView | null;
    },
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
    plan: {
      factUpserts: CustomerFact[];
      factIdsToMarkConflicted: string[];
      summaryUpsert: MemorySummaryView | null;
    },
  ): Promise<boolean> {
    const existing = this.facts.get(conversationId) ?? [];
    const byId = new Map(existing.map((f) => [f.fact_id, { ...f }]));
    for (const f of plan.factUpserts) byId.set(f.fact_id, { ...f });
    for (const factId of plan.factIdsToMarkConflicted) {
      const f = byId.get(factId);
      if (f) (f as CustomerFact).status = "conflicted";
    }
    this.facts.set(conversationId, [...byId.values()]);
    if (plan.summaryUpsert) this.summaries.set(conversationId, plan.summaryUpsert);
    return Promise.resolve(true);
  }

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
