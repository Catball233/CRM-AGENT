import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AnalysisResultSchema,
  ConversationViewSchema,
  ConversationSnapshotSchema,
  CustomerFactSchema,
  IdSchema,
  KnowledgeEvidenceSchema,
  MemorySummaryViewSchema,
  MessageViewSchema,
  QuoteResultSchema,
  RuleDefinitionSchema,
  type AssistantMessageView,
  type ConversationView,
  type CustomerFact,
  type KnowledgeEvidence,
  type MessageView,
  type QuoteResult,
  type SourceRef,
} from "@crm-agent/contracts";
import {
  ActivateRuleInputSchema,
  BeginTurnInputSchema,
  CompleteTurnInputSchema,
  ConversationFactInputSchema,
  FailTurnInputSchema,
  MemoryStateSchema,
  PersistedTurnSchema,
  ResolvedRuleSetSchema,
  RuleVersionRecordSchema,
  SaveQuoteInputSchema,
  SaveTurnInputSchema,
  type ActivateRuleInput,
  type BeginTurnInput,
  type CompleteTurnInput,
  type ConversationFactInput,
  type FailTurnInput,
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

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function inTransaction<T>(database: DatabaseSync, operation: () => T): T {
  if (database.isTransaction) return operation();
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

function assertNoOtherProcessingTurn(database: DatabaseSync, conversationId: string, turnId?: string): void {
  const row = database
    .prepare(`SELECT turn_id FROM turns
      WHERE conversation_id = ? AND status = 'PROCESSING' AND (? IS NULL OR turn_id <> ?)
      LIMIT 1`)
    .get(conversationId, turnId ?? null, turnId ?? null) as Row | undefined;
  if (row) throw new Error("CONVERSATION_BUSY: another turn is already processing");
}

function assertSourceRefsBelongToConversation(
  database: DatabaseSync,
  conversationId: string,
  refs: SourceRef[],
): void {
  const queries: Record<SourceRef["source_type"], string> = {
    message: "SELECT 1 FROM messages WHERE message_id = ? AND conversation_id = ?",
    memory_summary: "SELECT 1 FROM memory_summaries WHERE summary_id = ? AND conversation_id = ?",
    knowledge_chunk: "SELECT 1 FROM knowledge_evidence WHERE evidence_id = ? AND conversation_id = ?",
    quote: "SELECT 1 FROM quote_versions WHERE quote_id = ? AND conversation_id = ?",
  };
  for (const ref of refs) {
    const found = database.prepare(queries[ref.source_type]).get(ref.source_id, conversationId);
    if (!found) {
      throw new Error(
        `CROSS_CONVERSATION_REFERENCE: ${ref.source_type} ${ref.source_id} is not visible to ${conversationId}`,
      );
    }
  }
}

function assertAssistantEvidenceBelongsToTurn(
  database: DatabaseSync,
  conversationId: string,
  turnId: string,
  message: AssistantMessageView,
): void {
  for (const evidenceId of message.cited_evidence_ids) {
    const found = database
      .prepare(`SELECT 1 FROM knowledge_evidence
        WHERE evidence_id = ? AND conversation_id = ? AND turn_id = ?`)
      .get(evidenceId, conversationId, turnId);
    if (!found) {
      throw new Error(
        `CROSS_CONVERSATION_REFERENCE: cited evidence ${evidenceId} does not belong to the current turn`,
      );
    }
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

  beginTurn(input: BeginTurnInput): PersistedTurn {
    const request = BeginTurnInputSchema.parse(input);
    if (hashContent(request.content) !== request.content_hash) {
      throw new Error("content_hash does not match the client message content");
    }
    const existing = this.findByClientMessageId(request.conversation_id, request.client_message_id);
    if (existing) {
      const clientMessage = existing.messages.find((message) => message.message_id === existing.client_message_id);
      if (clientMessage?.content !== request.content || existing.content_hash !== request.content_hash) {
        throw new Error("IDEMPOTENCY_KEY_REUSED: client_message_id has different content");
      }
      return existing;
    }
    const now = new Date().toISOString();
    const nextSequenceRow = this.database
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM messages WHERE conversation_id = ?")
      .get(request.conversation_id) as Row | undefined;
    return this.saveTurn({
      conversation_id: request.conversation_id,
      turn_id: randomUUID(),
      client_message_id: request.client_message_id,
      content_hash: request.content_hash,
      status: "PROCESSING",
      started_at: now,
      warnings: [],
      messages: [{
        message_id: request.client_message_id,
        role: "user",
        content: request.content,
        sequence: numberValue(requiredRow(nextSequenceRow, "message sequence"), "next_sequence"),
        created_at: now,
      }],
    });
  }

  saveTurn(input: SaveTurnInput): PersistedTurn {
    const turn = SaveTurnInputSchema.parse(input);
    const incomingClientMessage = turn.messages.find(
      (message) => message.message_id === turn.client_message_id && message.role === "user",
    );
    if (!incomingClientMessage) throw new Error("client message is missing");
    const contentHash = turn.content_hash ?? hashContent(incomingClientMessage.content);
    if (contentHash !== hashContent(incomingClientMessage.content)) {
      throw new Error("content_hash does not match the client message content");
    }
    return inTransaction(this.database, () => {
      const existing = this.findTurnId(turn.conversation_id, turn.client_message_id);
      if (existing) {
        const persisted = this.getTurn(turn.conversation_id, existing);
        const storedClientMessage = persisted.messages.find(
          (message) => message.message_id === persisted.client_message_id,
        );
        if (storedClientMessage?.content !== incomingClientMessage.content || persisted.content_hash !== contentHash) {
          throw new Error("IDEMPOTENCY_KEY_REUSED: client_message_id has different content");
        }

        if (turn.retry_request_id && persisted.status === "FAILED") {
          if (turn.status !== "PROCESSING") {
            throw new Error("retry must transition a FAILED turn back to PROCESSING");
          }
          const retryability = requiredRow(
            this.database.prepare(`SELECT failure_retryable FROM turns
              WHERE turn_id = ? AND conversation_id = ? AND status = 'FAILED'`)
              .get(persisted.turn_id, turn.conversation_id) as Row | undefined,
            "failed turn",
          );
          if (nullableNumber(retryability, "failure_retryable") !== 1) {
            throw new Error("TURN_NOT_RETRYABLE: failed turn was marked as non-retryable");
          }
          assertNoOtherProcessingTurn(this.database, turn.conversation_id, persisted.turn_id);
          const priorAttempt = this.database
            .prepare(`SELECT turn_id FROM turn_retry_attempts
              WHERE conversation_id = ? AND retry_request_id = ?`)
            .get(turn.conversation_id, turn.retry_request_id) as Row | undefined;
          if (priorAttempt && stringValue(priorAttempt, "turn_id") !== persisted.turn_id) {
            throw new Error("IDEMPOTENCY_KEY_REUSED: retry_request_id belongs to another turn");
          }
          if (priorAttempt) return persisted;
          this.database.prepare(`INSERT INTO turn_retry_attempts (
            turn_id, conversation_id, retry_request_id, attempt_number, status, started_at
          ) VALUES (?, ?, ?, ?, 'PROCESSING', ?)`)
            .run(
              persisted.turn_id,
              turn.conversation_id,
              turn.retry_request_id,
              persisted.attempt_count + 1,
              turn.started_at,
            );
          this.database.prepare(`UPDATE turns SET
            retry_request_id = ?, status = 'PROCESSING', outcome = NULL,
            completed_at = NULL, failure_code = NULL, failure_retryable = NULL,
            warnings_json = ?, attempt_count = attempt_count + 1
            WHERE turn_id = ? AND conversation_id = ? AND status = 'FAILED'`)
            .run(turn.retry_request_id, JSON.stringify(turn.warnings), persisted.turn_id, turn.conversation_id);
          this.hooks?.afterStep?.("message_save", "turn_retry_started");
          return this.getTurn(turn.conversation_id, persisted.turn_id);
        }

        if (persisted.status === "PROCESSING" && turn.status !== "PROCESSING") {
          if (turn.turn_id !== persisted.turn_id) {
            throw new Error("turn_id cannot change while completing a processing turn");
          }
          this.insertMissingMessages(turn.conversation_id, persisted.turn_id, turn.messages);
          const result = this.database.prepare(`UPDATE turns SET
            status = ?, outcome = ?, completed_at = ?, failure_code = ?,
            failure_retryable = ?, warnings_json = ?
            WHERE turn_id = ? AND conversation_id = ? AND status = 'PROCESSING'`)
            .run(
              turn.status,
              turn.outcome ?? null,
              turn.completed_at ?? null,
              turn.failure_code ?? null,
              turn.status === "FAILED" ? 1 : null,
              JSON.stringify(turn.warnings),
              persisted.turn_id,
              turn.conversation_id,
            );
          if (result.changes !== 1) throw new Error("turn state transition lost its PROCESSING precondition");
          if (persisted.retry_request_id) {
            this.database.prepare(`UPDATE turn_retry_attempts SET status = ?, finished_at = ?
              WHERE turn_id = ? AND retry_request_id = ? AND status = 'PROCESSING'`)
              .run(turn.status, turn.completed_at ?? null, persisted.turn_id, persisted.retry_request_id);
          }
          this.updateConversationTimestamp(turn.conversation_id, turn.messages, turn.completed_at ?? turn.started_at);
          this.hooks?.afterStep?.("message_save", "turn_state_updated");
          return this.getTurn(turn.conversation_id, persisted.turn_id);
        }

        if (persisted.status === "FAILED" && !turn.retry_request_id) {
          throw new Error("TURN_RETRY_REQUIRED: failed turn requires retry_request_id");
        }
        if (persisted.status === turn.status) return persisted;
        if (persisted.status === "COMPLETED") return persisted;
        throw new Error(`invalid turn transition ${persisted.status} -> ${turn.status}`);
      }

      if (turn.retry_request_id) {
        throw new Error("retry_request_id cannot create a new turn");
      }
      if (turn.status === "PROCESSING") {
        assertNoOtherProcessingTurn(this.database, turn.conversation_id);
      }

      this.database
        .prepare(`INSERT INTO turns (
          turn_id, conversation_id, client_message_id, retry_request_id, status, outcome,
          started_at, completed_at, failure_code, warnings_json, content_hash, attempt_count,
          failure_retryable
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
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
          contentHash,
          turn.status === "FAILED" ? 1 : null,
        );
      this.hooks?.afterStep?.("message_save", "turn_inserted");

      this.insertMissingMessages(turn.conversation_id, turn.turn_id, turn.messages);
      this.hooks?.afterStep?.("message_save", "messages_inserted");

      this.updateConversationTimestamp(turn.conversation_id, turn.messages, turn.completed_at ?? turn.started_at);

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
      content_hash: stringValue(row, "content_hash") || hashContent(
        this.listMessages(id).find((message) => message.message_id === stringValue(row, "client_message_id"))?.content ?? "",
      ),
      retry_request_id: nullableString(row, "retry_request_id"),
      attempt_count: numberValue(row, "attempt_count"),
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

  private insertMissingMessages(conversationId: string, turnId: string, messages: MessageView[]): void {
    const insertMessage = this.database.prepare(`INSERT INTO messages (
      message_id, conversation_id, turn_id, role, content, sequence,
      cited_evidence_ids_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const message of messages) {
      const existing = this.database
        .prepare("SELECT conversation_id, turn_id, content FROM messages WHERE message_id = ?")
        .get(message.message_id) as Row | undefined;
      if (existing) {
        if (
          stringValue(existing, "conversation_id") !== conversationId ||
          stringValue(existing, "turn_id") !== turnId ||
          stringValue(existing, "content") !== message.content
        ) {
          throw new Error("message_id already exists with a different immutable payload");
        }
        continue;
      }
      if (message.role === "assistant") {
        assertAssistantEvidenceBelongsToTurn(this.database, conversationId, turnId, message);
      }
      insertMessage.run(
        message.message_id,
        conversationId,
        turnId,
        message.role,
        message.content,
        message.sequence,
        JSON.stringify(message.role === "assistant" ? message.cited_evidence_ids : []),
        message.created_at,
      );
    }
  }

  private updateConversationTimestamp(
    conversationId: string,
    messages: MessageView[],
    fallback: string,
  ): void {
    const updatedAt = [...messages.map((message) => message.created_at), fallback]
      .map((value) => ({ value, time: Date.parse(value) }))
      .sort((left, right) => right.time - left.time)[0]?.value ?? fallback;
    this.database.prepare(`UPDATE conversations SET updated_at = CASE
      WHEN datetime(updated_at) < datetime(?) THEN ? ELSE updated_at END
      WHERE conversation_id = ?`)
      .run(updatedAt, updatedAt, conversationId);
  }

  private findTurnId(conversationId: string, clientMessageId: string): string | null {
    const row = this.database
      .prepare("SELECT turn_id FROM turns WHERE conversation_id = ? AND client_message_id = ?")
      .get(conversationId, clientMessageId) as Row | undefined;
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
    assertSourceRefsBelongToConversation(this.database, conversationId, fact.source_refs);
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
      assertRuleRefsMatchDatabase(this.database, quote);
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

export class PersistenceUnitOfWork {
  constructor(
    private readonly database: DatabaseSync,
    private readonly hooks?: TransactionHooks,
  ) {}

  completeTurn(input: CompleteTurnInput): PersistedTurn {
    const completion = CompleteTurnInputSchema.parse(input);
    return inTransaction(this.database, () => {
      const processing = requiredRow(
        this.database.prepare(`SELECT * FROM turns
          WHERE turn_id = ? AND conversation_id = ? AND status = ?`)
          .get(completion.turn_id, completion.conversation_id, completion.expected_status) as Row | undefined,
        "processing turn",
      );
      this.insertKnowledgeEvidence(completion.conversation_id, completion.turn_id, completion.knowledge_evidence);
      this.hooks?.afterStep?.("turn_complete", "knowledge_evidence_saved");

      const facts = new FactRepository(this.database);
      for (const fact of completion.memory_plan.fact_upserts) {
        facts.save({ conversation_id: completion.conversation_id, fact });
      }
      for (const factId of completion.memory_plan.fact_ids_to_mark_conflicted) {
        const result = this.database.prepare(`UPDATE customer_facts SET status = 'conflicted'
          WHERE fact_id = ? AND conversation_id = ?`)
          .run(factId, completion.conversation_id);
        if (result.changes !== 1) {
          throw new Error(`fact ${factId} is not available in the current conversation`);
        }
      }
      if (completion.memory_plan.summary_upsert) {
        this.upsertSummary(completion.conversation_id, completion.memory_plan.summary_upsert);
      }
      this.hooks?.afterStep?.("turn_complete", "memory_saved");

      if (completion.quote_outcome?.kind === "quote") {
        new QuoteVersionRepository(this.database, this.hooks).save({
          turn_id: completion.turn_id,
          quote: completion.quote_outcome.quote,
        });
      }
      this.hooks?.afterStep?.("turn_complete", "quote_saved");

      assertAssistantEvidenceBelongsToTurn(
        this.database,
        completion.conversation_id,
        completion.turn_id,
        completion.assistant_message,
      );
      this.database.prepare(`INSERT INTO messages (
        message_id, conversation_id, turn_id, role, content, sequence,
        cited_evidence_ids_json, created_at
      ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)`)
        .run(
          completion.assistant_message.message_id,
          completion.conversation_id,
          completion.turn_id,
          completion.assistant_message.content,
          completion.assistant_message.sequence,
          JSON.stringify(completion.assistant_message.cited_evidence_ids),
          completion.assistant_message.created_at,
        );
      this.hooks?.afterStep?.("turn_complete", "assistant_message_saved");

      const outcome = deriveTurnOutcome(completion);
      const updated = this.database.prepare(`UPDATE turns SET
        status = 'COMPLETED', outcome = ?, completed_at = ?, failure_code = NULL,
        failure_retryable = NULL, analysis_json = ?
        WHERE turn_id = ? AND conversation_id = ? AND status = ?`)
        .run(
          outcome,
          completion.assistant_message.created_at,
          JSON.stringify(AnalysisResultSchema.parse(completion.analysis)),
          completion.turn_id,
          completion.conversation_id,
          completion.expected_status,
        );
      if (updated.changes !== 1) throw new Error("turn completion lost its PROCESSING precondition");
      const retryRequestId = nullableString(processing, "retry_request_id");
      if (retryRequestId) {
        this.database.prepare(`UPDATE turn_retry_attempts
          SET status = 'COMPLETED', finished_at = ?
          WHERE turn_id = ? AND retry_request_id = ? AND status = 'PROCESSING'`)
          .run(completion.assistant_message.created_at, completion.turn_id, retryRequestId);
      }
      this.database.prepare(`UPDATE conversations SET stage = ?, updated_at = ?
        WHERE conversation_id = ?`)
        .run(completion.final_stage, completion.assistant_message.created_at, completion.conversation_id);
      this.hooks?.afterStep?.("turn_complete", "turn_completed");
      return new MessageRepository(this.database).getTurn(completion.conversation_id, completion.turn_id);
    });
  }

  failTurn(input: FailTurnInput): PersistedTurn {
    const failure = FailTurnInputSchema.parse(input);
    return inTransaction(this.database, () => {
      const row = requiredRow(
        this.database.prepare(`SELECT retry_request_id FROM turns
          WHERE turn_id = ? AND conversation_id = ? AND status = ?`)
          .get(failure.turn_id, failure.conversation_id, failure.expected_status) as Row | undefined,
        "processing turn",
      );
      const failedAt = new Date().toISOString();
      const updated = this.database.prepare(`UPDATE turns SET
        status = 'FAILED', outcome = NULL, completed_at = ?, failure_code = ?,
        failure_retryable = ?
        WHERE turn_id = ? AND conversation_id = ? AND status = ?`)
        .run(
          failedAt,
          failure.error_code,
          failure.retryable ? 1 : 0,
          failure.turn_id,
          failure.conversation_id,
          failure.expected_status,
        );
      if (updated.changes !== 1) throw new Error("turn failure lost its PROCESSING precondition");
      const retryRequestId = nullableString(row, "retry_request_id");
      if (retryRequestId) {
        this.database.prepare(`UPDATE turn_retry_attempts
          SET status = 'FAILED', finished_at = ?
          WHERE turn_id = ? AND retry_request_id = ? AND status = 'PROCESSING'`)
          .run(failedAt, failure.turn_id, retryRequestId);
      }
      this.hooks?.afterStep?.("turn_fail", "turn_failed");
      return new MessageRepository(this.database).getTurn(failure.conversation_id, failure.turn_id);
    });
  }

  private insertKnowledgeEvidence(
    conversationId: string,
    turnId: string,
    evidenceItems: KnowledgeEvidence[],
  ): void {
    const insert = this.database.prepare(`INSERT INTO knowledge_evidence (
      evidence_id, conversation_id, turn_id, contract_version, knowledge_base_id,
      document_id, document_version, chunk_id, title, excerpt, score, metadata_json,
      candidate_rule_ids_json, provider_request_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
    for (const raw of evidenceItems) {
      const evidence = KnowledgeEvidenceSchema.parse(raw);
      insert.run(
        evidence.evidence_id,
        conversationId,
        turnId,
        evidence.contract_version,
        evidence.knowledge_base_id,
        evidence.document_id,
        evidence.document_version,
        evidence.chunk_id,
        evidence.title,
        evidence.excerpt,
        evidence.score,
        JSON.stringify(evidence.metadata),
        JSON.stringify(evidence.candidate_rule_ids),
        new Date().toISOString(),
      );
    }
  }

  private upsertSummary(
    conversationId: string,
    summary: CompleteTurnInput["memory_plan"]["summary_upsert"] & {},
  ): void {
    for (const messageId of summary.source_message_ids) {
      const found = this.database
        .prepare("SELECT 1 FROM messages WHERE message_id = ? AND conversation_id = ?")
        .get(messageId, conversationId);
      if (!found) {
        throw new Error(`summary source message ${messageId} is not available in the current conversation`);
      }
    }
    const existing = this.database
      .prepare("SELECT conversation_id FROM memory_summaries WHERE summary_id = ?")
      .get(summary.summary_id) as Row | undefined;
    if (existing && stringValue(existing, "conversation_id") !== conversationId) {
      throw new Error("summary_id already belongs to another conversation");
    }
    this.database.prepare(`INSERT INTO memory_summaries (
      summary_id, conversation_id, version, summary_text, covers_sequence_from,
      covers_sequence_to, source_message_ids_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(summary_id) DO UPDATE SET
      version = excluded.version,
      summary_text = excluded.summary_text,
      covers_sequence_from = excluded.covers_sequence_from,
      covers_sequence_to = excluded.covers_sequence_to,
      source_message_ids_json = excluded.source_message_ids_json,
      created_at = excluded.created_at`)
      .run(
        summary.summary_id,
        conversationId,
        summary.version,
        summary.text,
        summary.covers_sequence_from,
        summary.covers_sequence_to,
        JSON.stringify(summary.source_message_ids),
        summary.created_at,
      );
  }
}

function deriveTurnOutcome(input: CompleteTurnInput): "answer" | "question" | "quote" | "safe_stop" {
  if (input.quote_outcome?.kind === "quote") return "quote";
  if (
    input.analysis.recommended_next_action === "safe_stop" ||
    input.analysis.safety_flags.length > 0
  ) return "safe_stop";
  if (
    input.analysis.recommended_next_action === "ask_missing_fields" ||
    input.analysis.recommended_next_action === "clarify_conflict"
  ) return "question";
  return "answer";
}

function assertRuleRefsAreComplete(quote: QuoteResult): void {
  const expected = new Set(
    quote.items.map(
      (item) => `${item.rule_ref.rule_id}:${item.rule_ref.rule_version_id}:${item.rule_ref.version}`,
    ),
  );
  const declared = new Set(
    quote.rule_versions.map((rule) => `${rule.rule_id}:${rule.rule_version_id}:${rule.version}`),
  );
  if (expected.size !== declared.size || [...expected].some((key) => !declared.has(key))) {
    throw new Error("quote rule_versions must exactly match the rule references used by items");
  }
}

function assertRuleRefsMatchDatabase(database: DatabaseSync, quote: QuoteResult): void {
  for (const rule of quote.rule_versions) {
    const row = database
      .prepare("SELECT rule_id, version FROM rule_versions WHERE rule_version_id = ?")
      .get(rule.rule_version_id) as Row | undefined;
    if (
      !row ||
      stringValue(row, "rule_id") !== rule.rule_id ||
      numberValue(row, "version") !== rule.version
    ) {
      throw new Error(
        `quote rule reference does not match stored rule version ${rule.rule_version_id}`,
      );
    }
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
    unitOfWork: new PersistenceUnitOfWork(database, hooks),
  };
}
