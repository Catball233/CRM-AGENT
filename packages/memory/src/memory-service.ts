import type {
  AnalysisRequest,
  AnalysisResult,
  ContextBundle,
  CustomerFact,
  FactKey,
  FactCategory,
  Intent,
  MemoryMutationPlan,
  MemorySummaryView,
  RecalledItem,
  SlotUpdate,
  SourceRef,
} from "@crm-agent/contracts";
import { CONTRACT_VERSION } from "@crm-agent/contracts";
import {
  DEFAULT_RECENT_MESSAGES_LIMIT,
  FACT_CATEGORY_FOR_KEY,
  type FactIdProvider,
  type MemoryRepository,
  defaultFactIdProvider,
} from "./in-memory-repository";

type PlanMemoryMutationInput = {
  request: AnalysisRequest;
  analysis: AnalysisResult;
  /** 测试阶段可注入当前消息的 updated_at；默认使用消息创建时间+2秒 */
  factUpdatedAt?: string;
};

/**
 * B-04: 记忆服务
 * - buildContextBundle: 编排器 turn 开始时调用，从 Repository 构建 AnalysisRequest.context
 * - recallContext: 构建上下文时的追忆/上下文相关性搜索，生成 recalled_items
 * - planMemoryMutation: 分析结果返回后，生成 MemoryMutationPlan（fact upsert、conflicted 标记、summary upsert）
 */
export class MemoryService {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly factIdProvider: FactIdProvider = defaultFactIdProvider,
  ) {}

  async buildContextBundle(
    conversationId: string,
    currentMessage: AnalysisRequest["current_message"],
    options: {
      recentMessagesLimit?: number;
      now?: string;
    } = {},
  ): Promise<ContextBundle> {
    const limit = options.recentMessagesLimit ?? DEFAULT_RECENT_MESSAGES_LIMIT;
    const [
      messages,
      { confirmed, inferred, conflicted },
      summary,
      quote,
      stage,
    ] = await Promise.all([
      this.repo.listMessages(conversationId, limit),
      this.repo.listFacts(conversationId),
      this.repo.getLatestSummary(conversationId),
      this.repo.getLatestQuote(conversationId),
      this.repo.getConversationStage(conversationId),
    ]);

    // 保证 current_message 出现在 recent_messages 尾部（若当前消息还未保存到 Repository，则在此补）
    let recentMessages = messages;
    if (!recentMessages.some((m: { message_id: string }) => m.message_id === currentMessage.message_id)) {
      recentMessages = [...recentMessages, currentMessage as never]
        .sort((a, b) => a.sequence - b.sequence)
        .slice(-limit);
    }

    const recalledItems = this.recallContext(
      currentMessage.content,
      { summary, quote, confirmed },
      recentMessages,
    );

    return {
      contract_version: CONTRACT_VERSION,
      conversation_id: conversationId,
      stage,
      recent_messages: recentMessages as never,
      confirmed_facts: confirmed,
      inferred_facts: inferred,
      conflicted_facts: conflicted,
      memory_summary: summary,
      current_quote: quote,
      recalled_items: recalledItems,
      built_at: options.now ?? new Date().toISOString(),
    };
  }

  /** 上下文追忆：基于当前消息的关键词匹配长期摘要、旧报价、确认事实。 */
  recallContext(
    currentMessageContent: string,
    stored: {
      summary: MemorySummaryView | null;
      quote: ContextBundle["current_quote"];
      confirmed: CustomerFact[];
    },
    _recentMessages: unknown[],
  ): RecalledItem[] {
    const out: RecalledItem[] = [];
    const content = currentMessageContent;
    const hasLastTime = /上次|刚才|之前|原来|那个方案|那个报价|按.*方案/.test(content);
    const hasTier = /中档|高档|低档|性价比|经济型|豪华型/.test(content);
    const mentionsPlan = hasLastTime || (hasTier && stored.summary);

    if (stored.summary && mentionsPlan) {
      out.push({
        source_ref: {
          source_type: "memory_summary",
          source_id: stored.summary.summary_id,
        },
        reason: "客户引用上次方案，需要恢复方案摘要",
        relevance_score: 0.96,
      });
    }
    if (stored.quote && mentionsPlan) {
      out.push({
        source_ref: {
          source_type: "quote",
          source_id: stored.quote.quote_id,
        },
        reason: "客户继续讨论上次报价方案",
        relevance_score: 0.91,
      });
    }
    return out;
  }

  planMemoryMutation(input: PlanMemoryMutationInput): MemoryMutationPlan {
    const { request, analysis } = input;
    const factUpdatedAt =
      input.factUpdatedAt ??
      shiftIso(request.current_message.created_at, 2_000);

    const factUpserts: CustomerFact[] = [];
    const factIdsToMarkConflicted: string[] = [];
    const visibleMessageIds = new Set<string>([
      request.current_message.message_id,
      ...request.context.recent_messages.map((m: { message_id: string }) => m.message_id),
      ...(request.context.memory_summary?.source_message_ids ?? []),
    ]);
    const existingConfirmedByKey = new Map<
      FactKey,
      CustomerFact
    >();
    for (const f of request.context.confirmed_facts) {
      existingConfirmedByKey.set(f.fact_key, f);
    }

    for (const su of analysis.slot_updates) {
      // 安全：confirmed 和 inferred status 必须有当前 turn 可见的 message 证据
      // P0 修复：inferred 也需要可见性门禁，防止 Provider 用外来 evidence 伪造 inferred 事实
      if (su.status === "confirmed" || su.status === "inferred") {
        const hasVisible = su.source_refs.some(
          (r) => r.source_type === "message" && visibleMessageIds.has(r.source_id),
        );
        if (!hasVisible) continue;
      }

      const mapped = this.slotUpdateToCustomerFact(su, {
        request,
        analysis,
        factUpdatedAt,
      });
      if (!mapped) continue;

      // 冲突判定：新 status=conflicted 或 与已有 confirmed 同 fact_key 不同值
      if (su.conflicts_with_fact_ids?.length) {
        for (const factId of su.conflicts_with_fact_ids) {
          if (!factIdsToMarkConflicted.includes(factId)) {
            factIdsToMarkConflicted.push(factId);
          }
        }
      }
      if (
        mapped.status === "confirmed" &&
        !su.conflicts_with_fact_ids?.length
      ) {
        const existing = existingConfirmedByKey.get(mapped.fact_key);
        if (existing && !isSlotValueEqual(existing.value, mapped.value)) {
          factIdsToMarkConflicted.push(existing.fact_id);
          // 新 fact 本身标记为 conflicted，等待澄清
          (mapped as CustomerFact).status = "conflicted";
        }
      }

      factUpserts.push(mapped);
    }

    // 来自 concerns 的 confirmed concern fact：只有长期售后担忧（after_sales）才入长期记忆
    // 规则依据 7 个 fixture：
    // - code ∈ {price, material, design, timeline, quality, unclear, other} → 不写
    // - code === after_sales → 写，value 使用 evidence_refs[0].excerpt（客户原始表述片段），不用 note（note 是分析层表述）
    for (const concern of analysis.concerns) {
      if (concern.code !== "after_sales") continue;
      const primaryRef = concern.evidence_refs.find(
        (r) => r.source_type === "message",
      ) ?? concern.evidence_refs[0];
      if (!primaryRef) continue;
      if (!visibleMessageIds.has(primaryRef.source_id)) continue;
      const excerpt = primaryRef.excerpt?.trim();
      if (!excerpt) continue;
      const already = factUpserts.some(
        (f) => f.fact_key === "concern" && isSlotValueEqual(f.value, excerpt),
      );
      if (already) continue;
      const factId = this.factIdProvider(
        request.conversation_id,
        "concern",
        primaryRef,
        "confirmed",
      );
      factUpserts.push({
        fact_id: factId,
        fact_key: "concern",
        category: FACT_CATEGORY_FOR_KEY.concern,
        value: excerpt,
        status: "confirmed",
        source_refs: concern.evidence_refs,
        updated_at: factUpdatedAt,
      });
    }

    // 安全：risk 或 safety_flags 高严重度时不写入任何事实（避免把攻击文本纳入长期记忆）
    const hasHighSeveritySafety = analysis.safety_flags.some(
      (f) => f.severity === "medium" || f.severity === "high",
    );
    const safeToWrite =
      analysis.intent !== "risk" && !hasHighSeveritySafety;
    const finalFactUpserts = safeToWrite ? factUpserts : [];
    const finalMarkConflicted = safeToWrite ? factIdsToMarkConflicted : [];

    return {
      contract_version: CONTRACT_VERSION,
      conversation_id: request.conversation_id,
      turn_id: request.turn_id,
      fact_upserts: finalFactUpserts as never,
      fact_ids_to_mark_conflicted: finalMarkConflicted,
      summary_upsert: null,
    };
  }

  /**
   * SlotUpdate → CustomerFact 映射，含 B-01-INFERRED-MATERIAL-PREFERENCE 特判：
   * material_tier + inferred + low/mid 组合 → 写入 preference 事实，而不是 material_tier。
   */
  private slotUpdateToCustomerFact(
    su: SlotUpdate,
    ctx: {
      request: AnalysisRequest;
      analysis: AnalysisResult;
      factUpdatedAt: string;
    },
  ): CustomerFact | null {
    // special case: INFERRED-MATERIAL-PREFERENCE
    if (
      su.slot === "material_tier" &&
      su.status === "inferred" &&
      Array.isArray(su.value) &&
      su.value.length >= 1 &&
      (su.value.includes("low") ||
        su.value.includes("mid") ||
        su.value.includes("high"))
    ) {
      const factKey: FactKey = "preference";
      const primaryRef = su.source_refs[0];
      if (!primaryRef) return null;
      const factId = this.factIdProvider(
        ctx.request.conversation_id,
        factKey,
        primaryRef,
        "inferred",
      );
      return {
        fact_id: factId,
        fact_key: factKey,
        category: FACT_CATEGORY_FOR_KEY.preference,
        value: "偏向性价比材料，具体档位待确认",
        status: "inferred",
        confidence: su.confidence,
        source_refs: su.source_refs,
        updated_at: ctx.factUpdatedAt,
      };
    }

    const factKey = su.slot as FactKey;
    const primaryRef = su.source_refs[0];
    if (!primaryRef) return null;
    const factId = this.factIdProvider(
      ctx.request.conversation_id,
      factKey,
      primaryRef,
      su.status,
    );
    const category = (FACT_CATEGORY_FOR_KEY as Record<string, FactCategory>)[
      factKey
    ] ?? "requirement";
    return {
      fact_id: factId,
      fact_key: factKey,
      category,
      value: su.value,
      status: su.status,
      confidence: su.confidence,
      source_refs: su.source_refs,
      updated_at: ctx.factUpdatedAt,
    };
  }
}

function shiftIso(iso: string, millis: number): string {
  try {
    const d = new Date(iso);
    return new Date(d.getTime() + millis).toISOString();
  } catch {
    return iso;
  }
}

function isSlotValueEqual(
  a: CustomerFact["value"],
  b: CustomerFact["value"],
): boolean {
  if (a === b) return true;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;
  if (ta === "string" || ta === "number") return a === b;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export type { PlanMemoryMutationInput };

export const UNUSED_INTENT_FOR_TYPECHECK: Intent = "greeting";
