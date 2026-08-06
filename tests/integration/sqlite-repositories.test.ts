import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteRepositories,
  type RuleVersionRecord,
  type SaveTurnInput,
} from "../../packages/sqlite-repository/src/index";
import {
  migrateDatabase,
  openDatabase,
  rebuildDatabase,
} from "../../database/scripts/sqlite.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");
const migrationDirectory = resolve(projectRoot, "database/migrations");
const seedDirectory = resolve(projectRoot, "database/seed");
const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "crm-agent-repository-"));
  temporaryDirectories.push(directory);
  return directory;
}

function openMigratedDatabase(path = ":memory:") {
  const database = openDatabase(path);
  migrateDatabase(database, migrationDirectory);
  return database;
}

const ids = {
  conversation: "30000000-0000-4000-8000-000000000001",
  turn: "30000000-0000-4000-8000-000000000002",
  userMessage: "30000000-0000-4000-8000-000000000003",
  assistantMessage: "30000000-0000-4000-8000-000000000004",
  fact: "30000000-0000-4000-8000-000000000005",
  evidence: "30000000-0000-4000-8000-000000000006",
  ruleVersion: "30000000-0000-4000-8000-000000000007",
  quote: "30000000-0000-4000-8000-000000000008",
  quoteItem: "30000000-0000-4000-8000-000000000009",
} as const;

function conversation(conversationId = ids.conversation) {
  return {
    contract_version: "1.0.0" as const,
    conversation_id: conversationId,
    stage: "QUOTING" as const,
    status: "ACTIVE" as const,
    created_at: "2026-08-06T06:00:00Z",
    updated_at: "2026-08-06T06:00:00Z",
  };
}

function completedTurn(overrides: Partial<SaveTurnInput> = {}): SaveTurnInput {
  return {
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    client_message_id: ids.userMessage,
    status: "COMPLETED",
    outcome: "answer",
    started_at: "2026-08-06T06:01:00Z",
    completed_at: "2026-08-06T06:01:01Z",
    warnings: [],
    messages: [
      {
        message_id: ids.userMessage,
        role: "user",
        content: "这是虚构的 Repository 测试消息。",
        sequence: 1,
        created_at: "2026-08-06T06:01:00Z",
      },
      {
        message_id: ids.assistantMessage,
        role: "assistant",
        content: "这是虚构的 Repository 测试回复。",
        sequence: 2,
        cited_evidence_ids: [],
        created_at: "2026-08-06T06:01:01Z",
      },
    ],
    ...overrides,
  };
}

function validatedRule(
  ruleVersionId = ids.ruleVersion,
  version = 1,
  unitPriceFen = 12_000,
): RuleVersionRecord {
  return {
    rule_version_id: ruleVersionId,
    status: "validated",
    definition: {
      rule_id: "FIXTURE-C02-DESIGN-AREA",
      version,
      city: "示例市",
      calculation_type: "AREA_MULTIPLY",
      unit_price_fen: unitPriceFen,
      conditions: { service_scope: "whole_home" },
      effective_from: "2026-08-06T00:00:00Z",
    },
    source_document: "fixture://c02/repository",
    source_version: `fixture-${version}.0.0`,
    fixture_owner: "role-c-fixture",
    fixture_reviewer: "role-a-fixture",
    created_at: `2026-08-06T05:0${version}:00Z`,
    validated_at: `2026-08-06T05:1${version}:00Z`,
    activated_at: null,
  };
}

function insertEvidence(database: ReturnType<typeof openDatabase>) {
  database.prepare(`INSERT INTO knowledge_evidence (
    evidence_id, conversation_id, turn_id, knowledge_base_id, document_id,
    document_version, chunk_id, title, excerpt, score, created_at
  ) VALUES (?, ?, ?, 'kb-fixture', 'doc-fixture', '0.2.0', 'chunk-c02',
    'C-02 虚构依据', '仅用于 Repository 自动化测试。', 0.9, ?)`)
    .run(ids.evidence, ids.conversation, ids.turn, "2026-08-06T06:01:01Z");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite repositories and transactions", () => {
  it("round-trips conversations, turns, messages, and facts with idempotent client messages", () => {
    const database = openMigratedDatabase();
    try {
      const repositories = createSqliteRepositories(database);
      expect(repositories.conversations.create(conversation())).toEqual(conversation());

      const first = repositories.messages.saveTurn(completedTurn());
      const duplicate = repositories.messages.saveTurn(completedTurn({
        turn_id: "30000000-0000-4000-8000-000000000099",
      }));
      expect(duplicate.turn_id).toBe(first.turn_id);
      expect(repositories.messages.listMessagesForConversation(ids.conversation)).toHaveLength(2);
      expect(database.prepare("SELECT COUNT(*) AS count FROM turns").get()).toEqual({ count: 1 });
      const changedMessages = completedTurn().messages.map((message) =>
        message.role === "user" ? { ...message, content: "相同幂等键下的不同内容。" } : message,
      );
      expect(() => repositories.messages.saveTurn(completedTurn({ messages: changedMessages }))).toThrow(
        /IDEMPOTENCY_KEY_REUSED/,
      );

      const fact = repositories.facts.save({
        conversation_id: ids.conversation,
        fact: {
          fact_id: ids.fact,
          fact_key: "area_sqm",
          category: "requirement",
          value: 88,
          status: "confirmed",
          confidence: 1,
          source_refs: [{ source_type: "message", source_id: ids.userMessage }],
          updated_at: "2026-08-06T06:01:02Z",
        },
      });
      expect(fact.value).toBe(88);
      expect(repositories.facts.listForConversation(ids.conversation)).toEqual([fact]);
      expect(repositories.memory.loadForConversation(ids.conversation).confirmed_facts).toEqual([fact]);
      expect(repositories.messages.findByClientMessageId(ids.conversation, ids.userMessage)?.turn_id).toBe(ids.turn);
      expect(repositories.conversations.getSnapshot(ids.conversation).messages).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("rolls back a message transaction when a failure is injected", () => {
    const database = openMigratedDatabase();
    try {
      const repositories = createSqliteRepositories(database, {
        afterStep(boundary, step) {
          if (boundary === "message_save" && step === "turn_inserted") throw new Error("injected failure");
        },
      });
      repositories.conversations.create(conversation());
      expect(() => repositories.messages.saveTurn(completedTurn())).toThrow(/injected failure/);
      expect(database.prepare("SELECT COUNT(*) AS count FROM turns").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("activates one rule atomically and restores the prior active rule after rollback", () => {
    const database = openMigratedDatabase();
    try {
      const repositories = createSqliteRepositories(database);
      repositories.rules.create(validatedRule());
      repositories.rules.activate({
        rule_version_id: ids.ruleVersion,
        activated_at: "2026-08-06T06:02:00Z",
      });
      expect(repositories.rules.resolveActive(
        ["FIXTURE-C02-DESIGN-AREA", "FIXTURE-C02-MISSING"],
        "2026-08-06T06:02:01Z",
      )).toMatchObject({
        active_rule_versions: [{ rule_version_id: ids.ruleVersion }],
        unavailable_rule_ids: ["FIXTURE-C02-MISSING"],
      });
      const nextId = "30000000-0000-4000-8000-000000000017";
      repositories.rules.create(validatedRule(nextId, 2, 13_000));

      const failingRepositories = createSqliteRepositories(database, {
        afterStep(boundary, step) {
          if (boundary === "rule_activation" && step === "previous_rule_deactivated") {
            throw new Error("injected activation failure");
          }
        },
      });
      expect(() => failingRepositories.rules.activate({
        rule_version_id: nextId,
        activated_at: "2026-08-06T06:03:00Z",
      })).toThrow(/injected activation failure/);
      expect(repositories.rules.getActive("FIXTURE-C02-DESIGN-AREA")?.rule_version_id).toBe(ids.ruleVersion);
      expect(repositories.rules.get(nextId).status).toBe("validated");
    } finally {
      database.close();
    }
  });

  it("saves a quote atomically and leaves no partial rows when an evidence link fails", () => {
    const database = openMigratedDatabase();
    try {
      const repositories = createSqliteRepositories(database);
      repositories.conversations.create(conversation());
      repositories.messages.saveTurn(completedTurn({ outcome: "quote" }));
      repositories.rules.create(validatedRule());
      repositories.rules.activate({ rule_version_id: ids.ruleVersion, activated_at: "2026-08-06T06:02:00Z" });

      const quote = {
        contract_version: "1.0.0" as const,
        quote_id: ids.quote,
        conversation_id: ids.conversation,
        quote_version: 1,
        parent_quote_id: null,
        status: "estimated" as const,
        currency: "CNY" as const,
        parameters_snapshot: {
          city: "示例市",
          area_sqm: 88,
          house_state: "rough" as const,
          service_scope: "whole_home" as const,
          material_tier: "fixture_standard",
          designer_tier: "fixture_standard",
          quantities: {},
          special_requirements: [],
        },
        items: [{
          quote_item_id: ids.quoteItem,
          category: "design" as const,
          label: "虚构设计费",
          calculation_type: "AREA_MULTIPLY" as const,
          quantity: 88,
          unit: "sqm",
          unit_price_fen: 12_000,
          amount_fen: 1_056_000,
          calculation_inputs: { area_sqm: 88 },
          rule_ref: {
            rule_id: "FIXTURE-C02-DESIGN-AREA",
            rule_version_id: ids.ruleVersion,
            version: 1,
          },
        }],
        estimated_total_fen: 1_056_000,
        rule_versions: [{
          rule_id: "FIXTURE-C02-DESIGN-AREA",
          rule_version_id: ids.ruleVersion,
          version: 1,
        }],
        knowledge_evidence_ids: [ids.evidence],
        assumptions: ["仅用于虚构测试"],
        exclusions: [],
        disclaimer: "本报价为虚构测试数据，不构成商业报价。",
        created_at: "2026-08-06T06:04:00Z",
      };

      expect(() => repositories.quotes.save({ turn_id: ids.turn, quote })).toThrow();
      expect(database.prepare("SELECT COUNT(*) AS count FROM quote_versions").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM quote_items").get()).toEqual({ count: 0 });

      insertEvidence(database);
      expect(repositories.quotes.save({ turn_id: ids.turn, quote })).toEqual(quote);
      expect(repositories.quotes.save({ turn_id: ids.turn, quote })).toEqual(quote);
      expect(() => repositories.quotes.save({
        turn_id: ids.turn,
        quote: { ...quote, disclaimer: "试图覆盖不可变报价版本。" },
      })).toThrow(/different immutable payload/);
      expect(repositories.quotes.get(ids.conversation, ids.quote).disclaimer).toBe(quote.disclaimer);
      expect(repositories.quotes.listForConversation(ids.conversation)).toHaveLength(1);
      expect(repositories.quotes.nextVersion(ids.conversation)).toBe(2);
    } finally {
      database.close();
    }
  });

  it("restores repository data after restart and works after an empty database rebuild", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "restart.sqlite");
    const first = openMigratedDatabase(databasePath);
    try {
      const repositories = createSqliteRepositories(first);
      repositories.conversations.create(conversation());
      repositories.messages.saveTurn(completedTurn());
    } finally {
      first.close();
    }

    const reopened = openDatabase(databasePath);
    try {
      const repositories = createSqliteRepositories(reopened);
      expect(repositories.conversations.get(ids.conversation)).toEqual({
        ...conversation(),
        updated_at: "2026-08-06T06:01:01Z",
      });
      expect(repositories.messages.getTurn(ids.conversation, ids.turn).messages).toHaveLength(2);
    } finally {
      reopened.close();
    }

    const rebuiltPath = join(directory, "rebuilt.sqlite");
    expect(rebuildDatabase(rebuiltPath, projectRoot, migrationDirectory, seedDirectory)).toMatchObject({ integrity: "ok" });
    const rebuilt = openDatabase(rebuiltPath);
    try {
      const repositories = createSqliteRepositories(rebuilt);
      expect(repositories.conversations.get("10000000-0000-4000-8000-000000000001").contract_version).toBe("1.0.0");
    } finally {
      rebuilt.close();
    }
  });
});
