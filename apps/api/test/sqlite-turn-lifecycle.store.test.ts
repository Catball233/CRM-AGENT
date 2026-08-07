import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, migrateDatabase } from "../../../database/scripts/sqlite.mjs";
import { SqliteTurnLifecycleStore } from "../src/conversation/sqlite-turn-lifecycle.store";
import { validAnalysisResult } from "../../../packages/test-fixtures/src/index";
import { ConversationService } from "../src/conversation/conversation.service";
import {
  FakeAiProvider,
  FakeApiLogger,
  FakeKnowledgeProvider,
  FakeMemoryService,
  FakeQuoteService,
} from "../src/conversation/fake-adapters";

const migrations = resolve(import.meta.dirname, "../../../database/migrations");
const databases: Array<ReturnType<typeof openDatabase>> = [];

function setup() {
  const database = openDatabase(":memory:");
  databases.push(database);
  migrateDatabase(database, migrations);
  return { database, store: new SqliteTurnLifecycleStore(database) };
}

async function createConversation(store: SqliteTurnLifecycleStore) {
  return store.create({
    contract_version: "1.0.0",
    conversation_id: randomUUID(),
    created_at: "2026-08-07T00:00:00.000Z",
  });
}

async function completeQuestion(
  store: SqliteTurnLifecycleStore,
  conversationId: string,
  turnId: string,
  userMessageId: string,
) {
  return store.complete({
    conversation_id: conversationId,
    turn_id: turnId,
    final_stage: "QUALIFYING",
    analysis: {
      ...validAnalysisResult,
      value_assessment: {
        ...validAnalysisResult.value_assessment,
        evidence_refs: [{ source_type: "message", source_id: userMessageId }],
      },
      slot_updates: [],
    },
    memory_plan: {
      contract_version: "1.0.0",
      conversation_id: conversationId,
      turn_id: turnId,
      fact_upserts: [],
      fact_ids_to_mark_conflicted: [],
      summary_upsert: null,
    },
    knowledge_evidence: [],
    quote_outcome: null,
    assistant_message: {
      message_id: randomUUID(),
      role: "assistant",
      content: "请补充材料档位。",
      sequence: 2,
      cited_evidence_ids: [],
      created_at: new Date().toISOString(),
    },
  });
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("A-04 SQLite turn lifecycle", () => {
  it("persists a service completion and replays the completed SSE terminal events", async () => {
    const { store } = setup();
    const service = new ConversationService(
      store,
      new FakeAiProvider(),
      new FakeKnowledgeProvider(),
      new FakeMemoryService(store),
      new FakeQuoteService(),
      new FakeApiLogger(),
      store,
    );
    const conversation = await service.create({ contract_version: "1.0.0" });
    const clientMessageId = randomUUID();
    const request = {
      contract_version: "1.0.0" as const,
      client_message_id: clientMessageId,
      content: "请介绍服务内容。",
      response_mode: "stream" as const,
    };

    const first = await service.submit(conversation.conversation_id, request);
    expect(first).toMatchObject({ kind: "completed", result: { replayed: false, outcome: "answer" } });

    const replay = await service.submit(conversation.conversation_id, request);
    expect(replay).toMatchObject({ kind: "completed", result: { replayed: true } });
    expect(replay.events.map((event) => event.event_type)).toEqual(["turn.accepted", "turn.completed"]);
  });

  it("serializes a conversation and replays a completed client message", async () => {
    const { store } = setup();
    const conversation = await createConversation(store);
    const clientMessageId = randomUUID();
    const begun = await store.begin({
      conversation_id: conversation.conversation_id,
      client_message_id: clientMessageId,
      content: "请报价。",
    });
    expect(begun.kind).toBe("started");
    if (begun.kind !== "started") return;

    await expect(store.begin({
      conversation_id: conversation.conversation_id,
      client_message_id: randomUUID(),
      content: "另一条并发消息。",
    })).rejects.toThrow("CONVERSATION_BUSY");

    const completed = await completeQuestion(store, conversation.conversation_id, begun.turn_id, clientMessageId);
    expect(completed.outcome).toBe("question");
    expect(completed.question_fields).toEqual(["material_tier"]);

    const replay = await store.begin({
      conversation_id: conversation.conversation_id,
      client_message_id: clientMessageId,
      content: "请报价。",
    });
    expect(replay).toMatchObject({ kind: "completed", result: { replayed: true, turn_id: begun.turn_id } });
    await expect(store.begin({
      conversation_id: conversation.conversation_id,
      client_message_id: clientMessageId,
      content: "不同内容。",
    })).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
  });

  it("requires an explicit retry and makes retry requests idempotent", async () => {
    const { store } = setup();
    const conversation = await createConversation(store);
    const clientMessageId = randomUUID();
    const begun = await store.begin({
      conversation_id: conversation.conversation_id,
      client_message_id: clientMessageId,
      content: "模型暂时不可用。",
    });
    if (begun.kind !== "started") throw new Error("expected a new processing turn");
    await store.fail({
      conversation_id: conversation.conversation_id,
      turn_id: begun.turn_id,
      error_code: "MODEL_UNAVAILABLE",
      retryable: true,
    });

    expect(await store.begin({
      conversation_id: conversation.conversation_id,
      client_message_id: clientMessageId,
      content: "模型暂时不可用。",
    })).toMatchObject({ kind: "failed", turn_id: begun.turn_id, retryable: true });

    const retryRequestId = randomUUID();
    expect(await store.retry({
      conversation_id: conversation.conversation_id,
      turn_id: begun.turn_id,
      retry_request_id: retryRequestId,
    })).toMatchObject({ kind: "started", client_message_id: clientMessageId });
    expect(await store.retry({
      conversation_id: conversation.conversation_id,
      turn_id: begun.turn_id,
      retry_request_id: retryRequestId,
    })).toMatchObject({ kind: "processing", client_message_id: clientMessageId });
  });

  it("marks an interrupted processing turn retryable during startup recovery", async () => {
    const { database, store } = setup();
    const conversation = await createConversation(store);
    const clientMessageId = randomUUID();
    const begun = await store.begin({
      conversation_id: conversation.conversation_id,
      client_message_id: clientMessageId,
      content: "重启前处理中。",
    });
    if (begun.kind !== "started") throw new Error("expected a new processing turn");

    expect(await store.recover_interrupted()).toBe(1);
    expect(database.prepare("SELECT failure_code FROM turns WHERE turn_id = ?").get(begun.turn_id)).toEqual({
      failure_code: "INTERRUPTED_BY_RESTART",
    });
    expect(await store.begin({
      conversation_id: conversation.conversation_id,
      client_message_id: clientMessageId,
      content: "重启前处理中。",
    })).toMatchObject({ kind: "failed", turn_id: begun.turn_id, retryable: true });
  });
});
