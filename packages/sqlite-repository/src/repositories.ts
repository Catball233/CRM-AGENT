import type { DatabaseSync } from "node:sqlite";
import {
  ConversationViewSchema,
  ConversationSnapshotSchema,
  CustomerFactSchema,
  IdSchema,
  MemorySummaryViewSchema,
  MessageViewSchema,
  QuoteResultSchema,
  RuleDefinitionSchema,
  type ConversationView,
  type CustomerFact,
  type MessageView,
  type QuoteResult,
} from "@crm-agent/contracts";
import {
  ActivateRuleInputSchema,
  ConversationFactInputSchema,
  MemoryStateSchema,
  PersistedTurnSchema,
  ResolvedRuleSetSchema,
  RuleVersionRecordSchema,
  SaveQuoteInputSchema,
  SaveTurnInputSchema,
  type ActivateRuleInput,
  type ConversationFactInput,
  type MemoryState,
  type PersistedTurn,
  type RuleVersionRecord,
  type ResolvedRuleSet,
  type SaveQuoteInput,
  type SaveTurnInput,
  type TransactionHooks,
} from "./schemas";

type Row = Record<string, unknown>;

function requiredRow(row: Row | undefined, entity: string): Row {
  if (!row) throw new Error(`${entity} was not found`);
  return row;
}

function stringValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid ${key} in SQLite row`);
  return value;
}

function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Invalid ${key} in SQLite row`);
  return value;
}

function numberValue(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Invalid ${key} in SQLite row`);
  return value;
}

function nullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(`Invalid ${key} in SQLite row`);
  return value;
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON stored in ${field}`, { cause: error });
  }
}

function inTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export class ConversationRepository {
  constructor(private readonly database: DatabaseSync) {}

  create(input: ConversationView): ConversationView {
    const conversation = ConversationViewSchema.parse(input);
    this.database
      .prepare(`INSERT INTO conversations (
        conversation_id, contract_version, stage, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        conversation.conversation_id,
        conversation.contract_version,
        conversation.stage,
        conversation.status,
        conversation.created_at,
        conversation.updated_at,
      );
    return this.get(conversation.conversation_id);
  }

  get(conversationId: string): ConversationView {
    const id = IdSchema.parse(conversationId);
    const row = requiredRow(
      this.database.prepare("SELECT * FROM conversations WHERE conversation_id = ?").get(id) as Row | undefined,
      "conversation",
    );
    return ConversationViewSchema.parse({
      contract_version: stringValue(row, "contract_version"),
      conversation_id: stringValue(row, "conversation_id"),
      stage: stringValue(row, "stage"),
      status: stringValue(row, "status"),
      created_at: stringValue(row, "created_at"),
      updated_at: stringValue(row, "updated_at"),
    });
  }

  getSnapshot(conversationId: string): ReturnType<typeof ConversationSnapshotSchema.parse> {
    const conversation = this.get(conversationId);
    const messages = new MessageRepository(this.database).listMessagesForConversation(conversationId);
    const latestQuote = this.database
      .prepare("SELECT quote_id FROM quote_versions WHERE conversation_id = ? ORDER BY quote_version DESC LIMIT 1")
      .get(conversationId) as Row | undefined;
    const activeTurn = this.database
      .prepare("SELECT turn_id FROM turns WHERE conversation_id = ? AND status = 'PROCESSING' ORDER BY started_at LIMIT 1")
      .get(conversationId) as Row | undefined;
    return ConversationSnapshotSchema.parse({
      contract_version: "1.0.0",
      conversation,
      messages,
      current_quote: latestQuote
        ? new QuoteVersionRepository(this.database).get(conversationId, stringValue(latestQuote, "quote_id"))
        : null,
      active_turn_id: activeTurn ? stringValue(activeTurn, "turn_id") : null,
    });
  }
}

export class MessageRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly hooks?: TransactionHooks,
  ) {}

  saveTurn(input: SaveTurnInput): PersistedTurn {
    const turn = SaveTurnInputSchema.parse(input);
    return inTransaction(this.database, () => {
      const existing = this.findTurnId(turn.conversation_id, turn.client_message_id, turn.retry_request_id);
      if (existing) {
        const persisted = this.getTurn(turn.conversation_id, existing);
        const storedClientMessage = persisted.messages.find(
          (message) => message.message_id === persisted.client_message_id,
        );
        const incomingClientMessage = turn.messages.find(
          (message) => message.message_id === turn.client_message_id,
        );
        if (storedClientMessage?.content !== incomingClientMessage?.content) {
          throw new Error("IDEMPOTENCY_KEY_REUSED: client_message_id has different content");
        }
        return persisted;
      }

      this.database
        .prepare(`INSERT INTO turns (
          turn_id, conversation_id, client_message_id, retry_request_id, status, outcome,
          started_at, completed_at, failure_code, warnings_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          turn.turn_id,
          turn.conversation_id,
          turn.client_message_id,
          turn.retry_request_id ?? null,
          turn.status,
          turn.outcome ?? null,
          turn.started_at,
          turn.completed_at ?? null,
          turn.failure_code ?? null,
          JSON.stringify(turn.warnings),
        );
      this.hooks?.afterStep?.("message_save", "turn_inserted");

      const insertMessage = this.database.prepare(`INSERT INTO messages (
        message_id, conversation_id, turn_id, role, content, sequence,
        cited_evidence_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const message of turn.messages) {
        insertMessage.run(
          message.message_id,
          turn.conversation_id,
          turn.turn_id,
          message.role,
          message.content,
          message.sequence,
          JSON.stringify(message.role === "assistant" ? message.cited_evidence_ids : []),
          message.created_at,
        );
      }
      this.hooks?.afterStep?.("message_save", "messages_inserted");

      const updatedAt = [...turn.messages.map((message) => message.created_at), turn.completed_at ?? turn.started_at]
        .map((value) => ({ value, time: Date.parse(value) }))
        .sort((left, right) => right.time - left.time)[0]?.value ?? turn.started_at;
      this.database
        .prepare(`UPDATE conversations SET updated_at = CASE
          WHEN datetime(updated_at) < datetime(?) THEN ? ELSE updated_at END
          WHERE conversation_id = ?`)
        .run(updatedAt, updatedAt, turn.conversation_id);

      return this.getTurn(turn.conversation_id, turn.turn_id);
    });
  }

  getTurn(conversationId: string, turnId: string): PersistedTurn {
    const scopedConversationId = IdSchema.parse(conversationId);
    const id = IdSchema.parse(turnId);
    const row = requiredRow(
      this.database.prepare("SELECT * FROM turns WHERE conversation_id = ? AND turn_id = ?")
        .get(scopedConversationId, id) as Row | undefined,
      "turn",
    );
    return PersistedTurnSchema.parse({
      turn_id: stringValue(row, "turn_id"),
      conversation_id: stringValue(row, "conversation_id"),
      client_message_id: stringValue(row, "client_message_id"),
      retry_request_id: nullableString(row, "retry_request_id"),
      status: stringValue(row, "status"),
      outcome: nullableString(row, "outcome"),
      started_at: stringValue(row, "started_at"),
      completed_at: nullableString(row, "completed_at"),
      failure_code: nullableString(row, "failure_code"),
      warnings: parseJson(stringValue(row, "warnings_json"), "warnings_json"),
      messages: this.listMessages(id),
    });
  }

  listMessagesForConversation(conversationId: string): MessageView[] {
    const id = IdSchema.parse(conversationId);
    const rows = this.database
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY sequence")
      .all(id) as Row[];
    return rows.map(mapMessage);
  }

  findByClientMessageId(conversationId: string, clientMessageId: string): PersistedTurn | null {
    const scopedConversationId = IdSchema.parse(conversationId);
    const scopedClientMessageId = IdSchema.parse(clientMessageId);
    const turnId = this.findTurnId(scopedConversationId, scopedClientMessageId);
    return turnId ? this.getTurn(scopedConversationId, turnId) : null;
  }

  private listMessages(turnId: string): MessageView[] {
    const rows = this.database
      .prepare("SELECT * FROM messages WHERE turn_id = ? ORDER BY sequence")
      .all(turnId) as Row[];
    return rows.map(mapMessage);
  }

  private findTurnId(conversationId: string, clientMessageId: string, retryRequestId?: string): string | null {
    const row = this.database
      .prepare(`SELECT turn_id FROM turns
        WHERE conversation_id = ? AND (client_message_id = ? OR (? IS NOT NULL AND retry_request_id = ?))`)
      .get(conversationId, clientMessageId, retryRequestId ?? null, retryRequestId ?? null) as Row | undefined;
    return row ? stringValue(row, "turn_id") : null;
  }
}

function mapMessage(row: Row): MessageView {
  const role = stringValue(row, "role");
  const base = {
    message_id: stringValue(row, "message_id"),
    role,
    content: stringValue(row, "content"),
    sequence: numberValue(row, "sequence"),
    created_at: stringValue(row, "created_at"),
  };
  return MessageViewSchema.parse(
    role === "assistant"
      ? { ...base, cited_evidence_ids: parseJson(stringValue(row, "cited_evidence_ids_json"), "cited_evidence_ids_json") }
      : base,
  );
}

export class FactRepository {
  constructor(private readonly database: DatabaseSync) {}

  save(input: ConversationFactInput): CustomerFact {
    const { conversation_id: conversationId, fact } = ConversationFactInputSchema.parse(input);
    const existing = this.database
      .prepare("SELECT conversation_id FROM customer_facts WHERE fact_id = ?")
      .get(fact.fact_id) as Row | undefined;
    if (existing && stringValue(existing, "conversation_id") !== conversationId) {
      throw new Error("fact_id already belongs to another conversation");
    }
    this.database
      .prepare(`INSERT INTO customer_facts (
        fact_id, conversation_id, fact_key, category, value_json, status,
        confidence, source_refs_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fact_id) DO UPDATE SET
        fact_key = excluded.fact_key,
        category = excluded.category,
        value_json = excluded.value_json,
        status = excluded.status,
        confidence = excluded.confidence,
        source_refs_json = excluded.source_refs_json,
        updated_at = excluded.updated_at`)
      .run(
        fact.fact_id,
        conversationId,
        fact.fact_key,
        fact.category,
        JSON.stringify(fact.value),
        fact.status,
        fact.confidence ?? null,
        JSON.stringify(fact.source_refs),
        fact.updated_at,
      );
    return this.get(conversationId, fact.fact_id);
  }

  get(conversationId: string, factId: string): CustomerFact {
    const scopedConversationId = IdSchema.parse(conversationId);
    const id = IdSchema.parse(factId);
    const row = requiredRow(
      this.database.prepare("SELECT * FROM customer_facts WHERE conversation_id = ? AND fact_id = ?")
        .get(scopedConversationId, id) as Row | undefined,
      "fact",
    );
    return mapFact(row);
  }

  listForConversation(conversationId: string): CustomerFact[] {
    const id = IdSchema.parse(conversationId);
    return (this.database
      .prepare("SELECT * FROM customer_facts WHERE conversation_id = ? ORDER BY updated_at, fact_id")
      .all(id) as Row[]).map(mapFact);
  }
}

export class MemoryRepository {
  constructor(private readonly database: DatabaseSync) {}

  loadForConversation(conversationId: string): MemoryState {
    const id = IdSchema.parse(conversationId);
    const facts = (this.database
      .prepare("SELECT * FROM customer_facts WHERE conversation_id = ? ORDER BY updated_at, fact_id")
      .all(id) as Row[]).map(mapFact);
    const summaryRow = this.database
      .prepare("SELECT * FROM memory_summaries WHERE conversation_id = ? ORDER BY version DESC LIMIT 1")
      .get(id) as Row | undefined;
    const latestSummary = summaryRow
      ? MemorySummaryViewSchema.parse({
          summary_id: stringValue(summaryRow, "summary_id"),
          version: numberValue(summaryRow, "version"),
          text: stringValue(summaryRow, "summary_text"),
          covers_sequence_from: numberValue(summaryRow, "covers_sequence_from"),
          covers_sequence_to: numberValue(summaryRow, "covers_sequence_to"),
          source_message_ids: parseJson(
            stringValue(summaryRow, "source_message_ids_json"),
            "source_message_ids_json",
          ),
          created_at: stringValue(summaryRow, "created_at"),
        })
      : null;
    return MemoryStateSchema.parse({
      conversation_id: id,
      confirmed_facts: facts.filter((fact) => fact.status === "confirmed"),
      inferred_facts: facts.filter((fact) => fact.status === "inferred"),
      conflicted_facts: facts.filter((fact) => fact.status === "conflicted"),
      latest_summary: latestSummary,
    });
  }
}

function mapFact(row: Row): CustomerFact {
  const confidence = nullableNumber(row, "confidence");
  return CustomerFactSchema.parse({
    fact_id: stringValue(row, "fact_id"),
    fact_key: stringValue(row, "fact_key"),
    category: stringValue(row, "category"),
    value: parseJson(stringValue(row, "value_json"), "value_json"),
    status: stringValue(row, "status"),
    ...(confidence === null ? {} : { confidence }),
    source_refs: parseJson(stringValue(row, "source_refs_json"), "source_refs_json"),
    updated_at: stringValue(row, "updated_at"),
  });
}

export class RuleVersionRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly hooks?: TransactionHooks,
  ) {}

  create(input: RuleVersionRecord): RuleVersionRecord {
    const record = RuleVersionRecordSchema.parse(input);
    if (record.status === "active") {
      throw new Error("active rules must be created through the activation transaction");
    }
    const rule = record.definition;
    this.database.prepare(`INSERT INTO rule_versions (
      rule_version_id, rule_id, version, status, city, calculation_type,
      amount_fen, unit_price_fen, coefficient, base_rule_id, minimum_price_fen,
      conditions_json, conflict_group, effective_from, effective_to,
      source_document, source_version, fixture_owner, fixture_reviewer,
      created_at, validated_at, activated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.rule_version_id, rule.rule_id, rule.version, record.status, rule.city,
        rule.calculation_type, rule.amount_fen ?? null, rule.unit_price_fen ?? null,
        rule.coefficient ?? null, rule.base_rule_id ?? null, rule.minimum_price_fen ?? null,
        JSON.stringify(rule.conditions), rule.conflict_group ?? null, rule.effective_from,
        rule.effective_to ?? null, record.source_document, record.source_version,
        record.fixture_owner, record.fixture_reviewer, record.created_at,
        record.validated_at, record.activated_at,
      );
    return this.get(record.rule_version_id);
  }

  get(ruleVersionId: string): RuleVersionRecord {
    const id = IdSchema.parse(ruleVersionId);
    const row = requiredRow(
      this.database.prepare("SELECT * FROM rule_versions WHERE rule_version_id = ?").get(id) as Row | undefined,
      "rule version",
    );
    return mapRuleVersion(row);
  }

  getActive(ruleId: string): RuleVersionRecord | null {
    const parsedRuleId = RuleDefinitionSchema.shape.rule_id.parse(ruleId);
    const row = this.database
      .prepare("SELECT * FROM rule_versions WHERE rule_id = ? AND status = 'active'")
      .get(parsedRuleId) as Row | undefined;
    return row ? mapRuleVersion(row) : null;
  }

  resolveActive(ruleIds: string[], effectiveAt: string): ResolvedRuleSet {
    const requestedRuleIds = RuleDefinitionSchema.shape.rule_id.array().max(100).parse(ruleIds);
    const timestamp = ActivateRuleInputSchema.shape.activated_at.parse(effectiveAt);
    const active = requestedRuleIds.flatMap((ruleId) => {
      const row = this.database.prepare(`SELECT * FROM rule_versions
        WHERE rule_id = ? AND status = 'active'
          AND datetime(effective_from) <= datetime(?)
          AND (effective_to IS NULL OR datetime(effective_to) > datetime(?))`)
        .get(ruleId, timestamp, timestamp) as Row | undefined;
      return row ? [mapRuleVersion(row)] : [];
    });
    const activeIds = new Set(active.map((record) => record.definition.rule_id));
    const groups = new Map<string, string[]>();
    for (const record of active) {
      const group = record.definition.conflict_group;
      if (group) groups.set(group, [...(groups.get(group) ?? []), record.definition.rule_id]);
    }
    return ResolvedRuleSetSchema.parse({
      requested_rule_ids: requestedRuleIds,
      active_rule_versions: active.map((record) => ({
        rule_id: record.definition.rule_id,
        rule_version_id: record.rule_version_id,
        version: record.definition.version,
      })),
      unavailable_rule_ids: requestedRuleIds.filter((ruleId) => !activeIds.has(ruleId)),
      conflict_groups: [...groups.values()].filter((group) => group.length > 1),
    });
  }

  activate(input: ActivateRuleInput): RuleVersionRecord {
    const activation = ActivateRuleInputSchema.parse(input);
    return inTransaction(this.database, () => {
      const target = this.get(activation.rule_version_id);
      if (target.status === "active") return target;
      if (target.status !== "validated") throw new Error("only a validated rule version can be activated");

      this.database
        .prepare("UPDATE rule_versions SET status = 'inactive' WHERE rule_id = ? AND status = 'active'")
        .run(target.definition.rule_id);
      this.hooks?.afterStep?.("rule_activation", "previous_rule_deactivated");
      const result = this.database
        .prepare(`UPDATE rule_versions SET status = 'active', activated_at = ?
          WHERE rule_version_id = ? AND status = 'validated'`)
        .run(activation.activated_at, activation.rule_version_id);
      if (result.changes !== 1) throw new Error("rule activation did not update exactly one row");
      this.hooks?.afterStep?.("rule_activation", "target_rule_activated");
      return this.get(activation.rule_version_id);
    });
  }
}

function mapRuleVersion(row: Row): RuleVersionRecord {
  const optionalNumber = (key: string) => nullableNumber(row, key) ?? undefined;
  const optionalString = (key: string) => nullableString(row, key) ?? undefined;
  return RuleVersionRecordSchema.parse({
    rule_version_id: stringValue(row, "rule_version_id"),
    status: stringValue(row, "status"),
    definition: {
      rule_id: stringValue(row, "rule_id"),
      version: numberValue(row, "version"),
      city: stringValue(row, "city"),
      calculation_type: stringValue(row, "calculation_type"),
      ...(optionalNumber("amount_fen") === undefined ? {} : { amount_fen: optionalNumber("amount_fen") }),
      ...(optionalNumber("unit_price_fen") === undefined ? {} : { unit_price_fen: optionalNumber("unit_price_fen") }),
      ...(optionalNumber("coefficient") === undefined ? {} : { coefficient: optionalNumber("coefficient") }),
      ...(optionalString("base_rule_id") === undefined ? {} : { base_rule_id: optionalString("base_rule_id") }),
      ...(optionalNumber("minimum_price_fen") === undefined ? {} : { minimum_price_fen: optionalNumber("minimum_price_fen") }),
      conditions: parseJson(stringValue(row, "conditions_json"), "conditions_json"),
      ...(optionalString("conflict_group") === undefined ? {} : { conflict_group: optionalString("conflict_group") }),
      effective_from: stringValue(row, "effective_from"),
      ...(optionalString("effective_to") === undefined ? {} : { effective_to: optionalString("effective_to") }),
    },
    source_document: stringValue(row, "source_document"),
    source_version: stringValue(row, "source_version"),
    fixture_owner: stringValue(row, "fixture_owner"),
    fixture_reviewer: stringValue(row, "fixture_reviewer"),
    created_at: stringValue(row, "created_at"),
    validated_at: nullableString(row, "validated_at"),
    activated_at: nullableString(row, "activated_at"),
  });
}

export class QuoteVersionRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly hooks?: TransactionHooks,
  ) {}

  save(input: SaveQuoteInput): QuoteResult {
    const { turn_id: turnId, quote } = SaveQuoteInputSchema.parse(input);
    assertRuleRefsAreComplete(quote);
    return inTransaction(this.database, () => {
      const existing = this.database
        .prepare("SELECT quote_id FROM quote_versions WHERE quote_id = ?")
        .get(quote.quote_id) as Row | undefined;
      if (existing) {
        const persisted = this.get(quote.conversation_id, quote.quote_id);
        if (JSON.stringify(persisted) !== JSON.stringify(quote)) {
          throw new Error("quote_id already exists with a different immutable payload");
        }
        return persisted;
      }

      this.database.prepare(`INSERT INTO quote_versions (
        quote_id, conversation_id, turn_id, quote_version, parent_quote_id,
        status, currency, parameters_json, estimated_total_fen, assumptions_json,
        exclusions_json, disclaimer, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          quote.quote_id, quote.conversation_id, turnId, quote.quote_version,
          quote.parent_quote_id, quote.status, quote.currency,
          JSON.stringify(quote.parameters_snapshot), quote.estimated_total_fen,
          JSON.stringify(quote.assumptions), JSON.stringify(quote.exclusions),
          quote.disclaimer, quote.created_at,
        );
      this.hooks?.afterStep?.("quote_save", "quote_version_inserted");

      const insertItem = this.database.prepare(`INSERT INTO quote_items (
        quote_item_id, quote_id, position, category, label, calculation_type,
        quantity, unit, unit_price_fen, amount_fen, calculation_inputs_json,
        rule_version_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      quote.items.forEach((item, index) => {
        insertItem.run(
          item.quote_item_id, quote.quote_id, index + 1, item.category, item.label,
          item.calculation_type, item.quantity ?? null, item.unit ?? null,
          item.unit_price_fen ?? null, item.amount_fen, JSON.stringify(item.calculation_inputs),
          item.rule_ref.rule_version_id, quote.created_at,
        );
      });
      this.hooks?.afterStep?.("quote_save", "quote_items_inserted");

      const insertEvidence = this.database.prepare(`INSERT INTO quote_knowledge_evidence (
        quote_id, evidence_id, conversation_id
      ) VALUES (?, ?, ?)`);
      for (const evidenceId of quote.knowledge_evidence_ids) {
        insertEvidence.run(quote.quote_id, evidenceId, quote.conversation_id);
      }
      this.hooks?.afterStep?.("quote_save", "evidence_links_inserted");
      return this.get(quote.conversation_id, quote.quote_id);
    });
  }

  get(conversationId: string, quoteId: string): QuoteResult {
    const scopedConversationId = IdSchema.parse(conversationId);
    const id = IdSchema.parse(quoteId);
    const row = requiredRow(
      this.database.prepare("SELECT * FROM quote_versions WHERE conversation_id = ? AND quote_id = ?")
        .get(scopedConversationId, id) as Row | undefined,
      "quote version",
    );
    const itemRows = this.database.prepare(`SELECT qi.*, rv.rule_id, rv.version
      FROM quote_items qi JOIN rule_versions rv ON rv.rule_version_id = qi.rule_version_id
      WHERE qi.quote_id = ? ORDER BY qi.position`).all(id) as Row[];
    const items = itemRows.map((itemRow) => ({
      quote_item_id: stringValue(itemRow, "quote_item_id"),
      category: stringValue(itemRow, "category"),
      label: stringValue(itemRow, "label"),
      calculation_type: stringValue(itemRow, "calculation_type"),
      ...(nullableNumber(itemRow, "quantity") === null ? {} : { quantity: nullableNumber(itemRow, "quantity") }),
      ...(nullableString(itemRow, "unit") === null ? {} : { unit: nullableString(itemRow, "unit") }),
      ...(nullableNumber(itemRow, "unit_price_fen") === null ? {} : { unit_price_fen: nullableNumber(itemRow, "unit_price_fen") }),
      amount_fen: numberValue(itemRow, "amount_fen"),
      calculation_inputs: parseJson(stringValue(itemRow, "calculation_inputs_json"), "calculation_inputs_json"),
      rule_ref: {
        rule_id: stringValue(itemRow, "rule_id"),
        rule_version_id: stringValue(itemRow, "rule_version_id"),
        version: numberValue(itemRow, "version"),
      },
    }));
    const ruleVersions = [...new Map(items.map((item) => [item.rule_ref.rule_version_id, item.rule_ref])).values()];
    const evidenceRows = this.database
      .prepare("SELECT evidence_id FROM quote_knowledge_evidence WHERE quote_id = ? ORDER BY evidence_id")
      .all(id) as Row[];
    return QuoteResultSchema.parse({
      contract_version: "1.0.0",
      quote_id: stringValue(row, "quote_id"),
      conversation_id: stringValue(row, "conversation_id"),
      quote_version: numberValue(row, "quote_version"),
      parent_quote_id: nullableString(row, "parent_quote_id"),
      status: stringValue(row, "status"),
      currency: stringValue(row, "currency"),
      parameters_snapshot: parseJson(stringValue(row, "parameters_json"), "parameters_json"),
      items,
      estimated_total_fen: numberValue(row, "estimated_total_fen"),
      rule_versions: ruleVersions,
      knowledge_evidence_ids: evidenceRows.map((evidence) => stringValue(evidence, "evidence_id")),
      assumptions: parseJson(stringValue(row, "assumptions_json"), "assumptions_json"),
      exclusions: parseJson(stringValue(row, "exclusions_json"), "exclusions_json"),
      disclaimer: stringValue(row, "disclaimer"),
      created_at: stringValue(row, "created_at"),
    });
  }

  listForConversation(conversationId: string): QuoteResult[] {
    const id = IdSchema.parse(conversationId);
    const rows = this.database
      .prepare("SELECT quote_id FROM quote_versions WHERE conversation_id = ? ORDER BY quote_version")
      .all(id) as Row[];
    return rows.map((row) => this.get(id, stringValue(row, "quote_id")));
  }

  nextVersion(conversationId: string): number {
    const id = IdSchema.parse(conversationId);
    const row = this.database
      .prepare("SELECT COALESCE(MAX(quote_version), 0) + 1 AS next_version FROM quote_versions WHERE conversation_id = ?")
      .get(id) as Row | undefined;
    return numberValue(requiredRow(row, "quote version sequence"), "next_version");
  }
}

function assertRuleRefsAreComplete(quote: QuoteResult): void {
  const expected = new Set(quote.items.map((item) => `${item.rule_ref.rule_version_id}:${item.rule_ref.version}`));
  const declared = new Set(quote.rule_versions.map((rule) => `${rule.rule_version_id}:${rule.version}`));
  if (expected.size !== declared.size || [...expected].some((key) => !declared.has(key))) {
    throw new Error("quote rule_versions must exactly match the rule references used by items");
  }
}

export function createSqliteRepositories(database: DatabaseSync, hooks?: TransactionHooks) {
  return {
    conversations: new ConversationRepository(database),
    messages: new MessageRepository(database, hooks),
    facts: new FactRepository(database),
    memory: new MemoryRepository(database),
    rules: new RuleVersionRepository(database, hooks),
    quotes: new QuoteVersionRepository(database, hooks),
  };
}
