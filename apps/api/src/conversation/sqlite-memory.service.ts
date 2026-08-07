import type { DatabaseSync } from "node:sqlite";
import {
  AnalysisResultSchema,
  ContextBundleSchema,
  CustomerFactSchema,
  IdSchema,
  MemoryMutationPlanSchema,
} from "@crm-agent/contracts";
import { MemoryRepository } from "@crm-agent/sqlite-repository";
import type { ConversationRepository, MemoryService } from "./ports";

/**
 * Reads the facts and summaries committed by the A-04 unit of work. Mutations
 * are deliberately a no-op here because `PersistenceUnitOfWork.completeTurn`
 * owns their transaction with the rest of the terminal turn evidence.
 */
export class SqliteMemoryService implements MemoryService {
  private readonly memory: MemoryRepository;

  constructor(
    database: DatabaseSync,
    private readonly conversations: Pick<ConversationRepository, "get_snapshot">,
  ) {
    this.memory = new MemoryRepository(database);
  }

  async build_context(conversationId: string, currentMessageId: string) {
    const id = IdSchema.parse(conversationId);
    IdSchema.parse(currentMessageId);
    const [snapshot, state] = await Promise.all([
      this.conversations.get_snapshot(id),
      Promise.resolve(this.memory.loadForConversation(id)),
    ]);
    const currentQuote = snapshot?.current_quote ?? null;
    return ContextBundleSchema.parse({
      contract_version: "1.0.0",
      conversation_id: id,
      stage: snapshot?.conversation.stage ?? "DISCOVERY",
      recent_messages: snapshot?.messages.slice(-20) ?? [],
      confirmed_facts: state.confirmed_facts,
      inferred_facts: state.inferred_facts,
      conflicted_facts: state.conflicted_facts,
      memory_summary: state.latest_summary,
      current_quote: currentQuote === null
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
        fact_id: crypto.randomUUID(),
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
      .flatMap((update) => update.conflicts_with_fact_ids ?? context.confirmed_facts
        .filter((fact) => fact.fact_key === update.slot)
        .map((fact) => fact.fact_id));
    return MemoryMutationPlanSchema.parse({
      contract_version: "1.0.0",
      conversation_id: conversationId,
      turn_id: turnId,
      fact_upserts: factUpserts,
      fact_ids_to_mark_conflicted: [...new Set(factIdsToMarkConflicted)],
      summary_upsert: null,
    });
  }

  async apply_mutation(): Promise<void> {
    // See class note: lifecycle completion persists this plan atomically.
  }
}
