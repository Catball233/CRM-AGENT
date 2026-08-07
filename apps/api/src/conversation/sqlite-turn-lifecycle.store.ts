import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ConversationRepository as SqliteConversationRepository,
  MessageRepository,
  PersistenceUnitOfWork,
  QuoteVersionRepository,
} from "@crm-agent/sqlite-repository";
import {
  AnalysisResultSchema,
  ChatTurnResultSchema,
  ConversationSnapshotSchema,
  ConversationViewSchema,
  type AssistantMessageView,
  type ChatTurnResult,
} from "@crm-agent/contracts";
import type {
  ConversationRepository,
  CreateConversationInput,
  TurnLifecycleStore,
} from "./ports";

/**
 * A-04 SQLite boundary. Provider calls never enter this class: `begin`,
 * `complete`, `fail`, retry and startup recovery are each short local DB
 * operations.  `PersistenceUnitOfWork` owns the all-or-nothing completion.
 */
export class SqliteTurnLifecycleStore implements ConversationRepository, TurnLifecycleStore {
  private readonly conversations: SqliteConversationRepository;
  private readonly messages: MessageRepository;
  private readonly unitOfWork: PersistenceUnitOfWork;
  private readonly quotes: QuoteVersionRepository;

  constructor(private readonly database: DatabaseSync) {
    this.conversations = new SqliteConversationRepository(database);
    this.messages = new MessageRepository(database);
    this.unitOfWork = new PersistenceUnitOfWork(database);
    this.quotes = new QuoteVersionRepository(database);
  }

  async create(input: CreateConversationInput) {
    return ConversationViewSchema.parse(this.conversations.create({
      ...input,
      stage: "DISCOVERY",
      status: "ACTIVE",
      updated_at: input.created_at,
    }));
  }

  async get_snapshot(conversationId: string) {
    try {
      return ConversationSnapshotSchema.parse(this.conversations.getSnapshot(conversationId));
    } catch (error) {
      if (error instanceof Error && error.message.includes("was not found")) return null;
      throw error;
    }
  }

  async save_snapshot(): Promise<void> {
    throw new Error("A-04 must use TurnLifecycleStore.complete instead of save_snapshot");
  }

  async delete_local_test_conversation(conversationId: string) {
    this.database.prepare("DELETE FROM conversations WHERE conversation_id = ?").run(conversationId);
  }

  async begin(input: Parameters<TurnLifecycleStore["begin"]>[0]) {
    const existing = this.messages.findByClientMessageId(input.conversation_id, input.client_message_id);
    const turn = this.messages.beginTurn({
      ...input,
      content_hash: createHash("sha256").update(input.content).digest("hex"),
    });
    if (turn.status === "COMPLETED") return { kind: "completed" as const, result: this.resultFor(turn, true) };
    if (turn.status === "PROCESSING" && existing !== null) {
      return { kind: "processing" as const, turn_id: turn.turn_id, client_message_id: turn.client_message_id };
    }
    if (turn.status === "FAILED") return { kind: "failed" as const, turn_id: turn.turn_id, retryable: this.retryable(turn.turn_id) };
    const user = turn.messages.find((message) => message.message_id === turn.client_message_id);
    if (!user || user.role !== "user") throw new Error("processing turn has no user message");
    return { kind: "started" as const, turn_id: turn.turn_id, user_message: user };
  }

  async complete(input: Parameters<TurnLifecycleStore["complete"]>[0]): Promise<ChatTurnResult> {
    const { quote_commit, ...completion } = input;
    const turn = this.unitOfWork.completeTurn({ ...completion, expected_status: "PROCESSING" }, quote_commit);
    return this.resultFor(turn, false);
  }

  async fail(input: Parameters<TurnLifecycleStore["fail"]>[0]): Promise<void> {
    this.unitOfWork.failTurn({ ...input, expected_status: "PROCESSING" });
  }

  async retry(input: Parameters<TurnLifecycleStore["retry"]>[0]) {
    let persisted;
    try {
      persisted = this.messages.getTurn(input.conversation_id, input.turn_id);
    } catch {
      throw new Error("TURN_NOT_FOUND");
    }
    if (persisted.status === "COMPLETED") return { kind: "completed" as const, result: this.resultFor(persisted, true) };
    if (persisted.status === "PROCESSING") {
      return { kind: "processing" as const, client_message_id: persisted.client_message_id };
    }
    if (!this.retryable(persisted.turn_id)) throw new Error("TURN_NOT_RETRYABLE");
    const user = persisted.messages.find((message) => message.message_id === persisted.client_message_id);
    if (!user || user.role !== "user") throw new Error("failed turn has no user message");
    const restarted = this.messages.saveTurn({
      conversation_id: input.conversation_id,
      turn_id: persisted.turn_id,
      client_message_id: persisted.client_message_id,
      retry_request_id: input.retry_request_id,
      status: "PROCESSING",
      started_at: new Date().toISOString(),
      warnings: [],
      messages: [user],
    });
    if (restarted.status === "COMPLETED") return { kind: "completed" as const, result: this.resultFor(restarted, true) };
    if (restarted.status !== "PROCESSING") throw new Error("retry did not start processing");
    return { kind: "started" as const, client_message_id: user.message_id, content: user.content };
  }

  async recover_interrupted(): Promise<number> {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database.prepare("SELECT turn_id, retry_request_id FROM turns WHERE status = 'PROCESSING'").all() as Array<Record<string, unknown>>;
      const update = this.database.prepare(`UPDATE turns SET status = 'FAILED', completed_at = ?,
        failure_code = 'INTERRUPTED_BY_RESTART', failure_retryable = 1 WHERE turn_id = ? AND status = 'PROCESSING'`);
      const retryUpdate = this.database.prepare(`UPDATE turn_retry_attempts SET status = 'FAILED', finished_at = ?
        WHERE turn_id = ? AND status = 'PROCESSING'`);
      for (const row of rows) {
        const turnId = String(row.turn_id);
        update.run(now, turnId);
        if (row.retry_request_id !== null) retryUpdate.run(now, turnId);
      }
      this.database.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private retryable(turnId: string): boolean {
    const row = this.database.prepare("SELECT failure_retryable FROM turns WHERE turn_id = ?").get(turnId) as { failure_retryable?: number | null } | undefined;
    return row?.failure_retryable === 1;
  }

  private resultFor(turn: ReturnType<MessageRepository["getTurn"]>, replayed: boolean): ChatTurnResult {
    if (turn.status !== "COMPLETED" || turn.outcome === null || turn.completed_at === null) {
      throw new Error("turn is not completed");
    }
    const user = turn.messages.find((message) => message.message_id === turn.client_message_id);
    const assistant = turn.messages.find((message): message is AssistantMessageView => message.role === "assistant");
    if (!user || user.role !== "user" || !assistant) throw new Error("completed turn is missing messages");
    const quoteRow = this.database.prepare("SELECT quote_id FROM quote_versions WHERE turn_id = ?").get(turn.turn_id) as { quote_id?: string } | undefined;
    const analysisRow = this.database.prepare("SELECT analysis_json FROM turns WHERE turn_id = ?").get(turn.turn_id) as { analysis_json?: string | null } | undefined;
    const analysis = analysisRow?.analysis_json
      ? AnalysisResultSchema.parse(JSON.parse(analysisRow.analysis_json))
      : null;
    const snapshot = this.conversations.getSnapshot(turn.conversation_id);
    return ChatTurnResultSchema.parse({
      contract_version: "1.0.0",
      turn_id: turn.turn_id,
      conversation_id: turn.conversation_id,
      client_message_id: turn.client_message_id,
      status: "COMPLETED",
      outcome: turn.outcome,
      stage: snapshot.conversation.stage,
      user_message: user,
      assistant_message: assistant,
      question_fields: turn.outcome === "question"
        ? (analysis?.missing_fields.map((field) => field.slot).slice(0, 3) ?? [])
        : [],
      quote: quoteRow?.quote_id ? this.quotes.get(turn.conversation_id, quoteRow.quote_id) : null,
      warnings: turn.warnings,
      replayed,
      completed_at: turn.completed_at,
    });
  }
}
