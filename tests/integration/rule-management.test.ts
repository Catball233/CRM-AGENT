import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RuleActivationError,
  RuleImportValidationError,
  RuleManagementService,
  floorRevenueFen,
  type RuleImportSource,
} from "../../packages/rule-management/src/index";
import { migrateDatabase, openDatabase } from "../../database/scripts/sqlite.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");
const migrationDirectory = resolve(projectRoot, "database/migrations");
const sampleRules = readFileSync(
  resolve(projectRoot, "data/quote-rule-samples/c04-fictional-valid-bundle.json"),
  "utf8",
);
const temporaryDirectories: string[] = [];
const checkedAt = "2026-08-06T02:00:00Z";
const ids = {
  bundle: "40000000-0000-4000-8000-000000000001",
  supplier: "40000000-0000-4000-8000-000000000002",
  promotion: "40000000-0000-4000-8000-000000000003",
  fixture: "40000000-0000-4000-8000-000000000004",
};

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "crm-agent-c04-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "test.sqlite"));
  migrateDatabase(database, migrationDirectory);
  return database;
}

function service(database: ReturnType<typeof openDatabase>, hook?: (boundary: string, step: string) => void) {
  return new RuleManagementService(database, {
    cities: ["北京", "上海"],
    scenes: ["整装", "局部翻新"],
    trades: ["木工", "水电"],
    material_tiers: ["经济", "标准", "高端"],
    designer_tiers: ["标准", "资深", "首席"],
  }, hook ? { afterStep: hook } : undefined);
}

function validInput(overrides: Partial<RuleImportSource> = {}): RuleImportSource {
  const input: RuleImportSource = {
    format: "json",
    content: sampleRules,
    metadata: {
      contract_version: "1.0.0",
      bundle_id: ids.bundle,
      source_document: "fixtures/C04-fictional-rules.md",
      source_version: "0.2.0",
      fixture_owner: "C",
      fixture_reviewer: "A",
      reconciliation_fixture_ids: [ids.fixture],
    },
    source_evidence: [{
      source_ref: "fixtures/C04-fictional-rules.md",
      document_version: "0.2.0",
      chunk_id: "fixture-chunk-001",
      candidate_rule_ids: ["FIXTURE-BEIJING-DESIGN-STANDARD"],
    }],
    guardrails: [{
      rule_id: "FIXTURE-BEIJING-DESIGN-STANDARD",
      minimum_margin_bps: 2_000,
      maximum_discount_bps: 1_000,
      cost_rule_refs: [],
      supplier_quote_snapshot_refs: [ids.supplier],
      gift_cost_fen: 2_000,
      free_service_cost_fen: 3_000,
    }],
    supplier_quote_snapshots: [{
      supplier_quote_snapshot_id: ids.supplier,
      supplier_ref: "FICTIONAL-SUPPLIER-A",
      quote_version: "fixture-1",
      region: "北京",
      currency: "CNY",
      valid_from: "2026-08-01T00:00:00Z",
      valid_to: "2026-12-31T23:59:59Z",
      captured_at: "2026-08-01T01:00:00Z",
      items: [{
        item_ref: "FIXTURE-APPLIANCE-001",
        category: "appliance",
        quantity: 1,
        wholesale_cost_fen: 300_000,
        delivery_cost_fen: 10_000,
        installation_cost_fen: 5_000,
        warranty_cost_fen: 2_000,
      }],
    }],
    promotion_rules: [{
      promotion_rule_version_id: ids.promotion,
      promotion_id: "FIXTURE-LOW-INTENT-GIFT",
      version: 1,
      city: "北京",
      intent_levels: ["low"],
      benefit_type: "gift",
      benefit_cost_fen: 5_000,
      minimum_subtotal_fen: 500_000,
      priority: 10,
      exclusion_group: "FIXTURE-ACQUISITION",
      stackable: false,
      effective_from: "2026-08-01T00:00:00Z",
      effective_to: "2026-12-31T23:59:59Z",
    }],
    reconciliation_cases: [{
      fixture_id: ids.fixture,
      total_cost_fen: 800_000,
      subtotal_fen: 1_100_000,
      requested_discount_fen: 100_000,
      minimum_margin_bps: 2_000,
      expected_allowed: true,
    }],
  };
  return { ...input, ...overrides };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("C-04 rule import, validation, and activation", () => {
  it("imports, validates, activates, and audits a traceable bundle", () => {
    const database = temporaryDatabase();
    try {
      const manager = service(database);
      const imported = manager.importSource(validInput(), checkedAt);
      expect(imported.candidate_rule_version_ids).toHaveLength(1);
      expect(manager.validateBundle(ids.bundle, checkedAt)).toEqual({
        bundle_id: ids.bundle,
        valid: true,
        issues: [],
      });
      expect(manager.activateBundle({
        bundle_id: ids.bundle,
        activated_at: checkedAt,
        approved_by: "A",
        approval_note: "Approved fictional C-04 fixture",
      }).activated_rule_version_ids).toEqual(imported.candidate_rule_version_ids);
      expect(database.prepare("SELECT status FROM rule_import_bundles WHERE bundle_id = ?").get(ids.bundle))
        .toEqual({ status: "active" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM rule_activation_audit").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT status FROM promotion_rule_versions WHERE promotion_id = ?")
        .get("FIXTURE-LOW-INTENT-GIFT")).toEqual({ status: "active" });
    } finally {
      database.close();
    }
  });

  it.each(["json", "csv", "markdown"] as const)("accepts the agreed %s source format", (format) => {
    const database = temporaryDatabase();
    try {
      const jsonRule = JSON.parse(sampleRules)[0];
      const content = format === "json" ? sampleRules : format === "markdown"
        ? `# Fixture\n\n\`\`\`json\n${sampleRules}\n\`\`\``
        : [
          "rule_id,version,city,calculation_type,amount_fen,unit_price_fen,coefficient,base_rule_id,minimum_price_fen,conditions_json,conflict_group,effective_from,effective_to",
          `${jsonRule.rule_id},1,北京,AREA_MULTIPLY,,8000,,,,\"{\"\"scene\"\":\"\"整装\"\",\"\"designer_tier\"\":\"\"标准\"\"}\",,2026-01-01T00:00:00Z,2027-01-01T00:00:00Z`,
        ].join("\n");
      service(database).importSource(validInput({ format, content }), checkedAt);
      expect(database.prepare("SELECT COUNT(*) AS count FROM rule_import_bundles").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("rejects malformed input without leaving partial records", () => {
    const database = temporaryDatabase();
    try {
      expect(() => service(database).importSource(validInput({ content: "not-json" }), checkedAt))
        .toThrow(RuleImportValidationError);
      expect(database.prepare("SELECT COUNT(*) AS count FROM rule_import_bundles").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM rule_versions").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("reports duplicate rule versions before SQLite writes", () => {
    const database = temporaryDatabase();
    try {
      const manager = service(database);
      manager.importSource(validInput(), checkedAt);
      const duplicate = validInput({
        metadata: { ...validInput().metadata, bundle_id: "40000000-0000-4000-8000-000000000011" },
      });
      expect(() => manager.importSource(duplicate, checkedAt)).toThrow(RuleImportValidationError);
      expect(database.prepare("SELECT COUNT(*) AS count FROM rule_import_bundles").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("keeps expired supplier quotes and conflicting rules in draft", () => {
    const database = temporaryDatabase();
    try {
      const base = validInput();
      const secondRule = {
        ...JSON.parse(sampleRules)[0],
        rule_id: "FIXTURE-BEIJING-DESIGN-CONFLICT",
        conflict_group: "FIXTURE-DESIGN-ONLY-ONE",
      };
      const firstRule = { ...JSON.parse(sampleRules)[0], conflict_group: "FIXTURE-DESIGN-ONLY-ONE" };
      const snapshots = base.supplier_quote_snapshots?.map((snapshot) => ({
        ...snapshot,
        valid_to: "2026-08-05T23:59:59Z",
      }));
      const guardrails = [
        ...(base.guardrails ?? []),
        { ...(base.guardrails?.[0] ?? {}), rule_id: secondRule.rule_id },
      ];
      const evidence = base.source_evidence?.map((entry) => ({
        ...entry,
        candidate_rule_ids: [...entry.candidate_rule_ids, secondRule.rule_id],
      }));
      service(database).importSource(validInput({
        content: JSON.stringify([firstRule, secondRule]),
        supplier_quote_snapshots: snapshots,
        guardrails,
        source_evidence: evidence,
      }), checkedAt);
      const report = service(database).validateBundle(ids.bundle, checkedAt);
      expect(report.valid).toBe(false);
      expect(report.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        "SUPPLIER_QUOTE_EXPIRED",
        "CONFLICT_GROUP_OVERLAP",
      ]));
      expect(database.prepare("SELECT status FROM rule_import_bundles WHERE bundle_id = ?").get(ids.bundle))
        .toEqual({ status: "draft" });
    } finally {
      database.close();
    }
  });

  it("detects a reconciliation fixture that would breach the minimum profit floor", () => {
    const database = temporaryDatabase();
    try {
      const base = validInput();
      service(database).importSource(validInput({
        reconciliation_cases: base.reconciliation_cases.map((fixture) => ({
          ...fixture,
          expected_allowed: true,
          subtotal_fen: 900_000,
          requested_discount_fen: 100_000,
        })),
      }), checkedAt);
      const report = service(database).validateBundle(ids.bundle, checkedAt);
      expect(report.valid).toBe(false);
      expect(report.issues.map((entry) => entry.code)).toContain("PROFIT_FLOOR_FIXTURE_MISMATCH");
      expect(floorRevenueFen(800_000, 2_000)).toBe(1_000_000);
    } finally {
      database.close();
    }
  });

  it("rejects a cash promotion above the strictest active rule discount guardrail", () => {
    const database = temporaryDatabase();
    try {
      const base = validInput();
      service(database).importSource(validInput({
        promotion_rules: base.promotion_rules.map((promotion) => ({
          ...promotion,
          benefit_type: "cash_discount" as const,
          discount_bps: 1_500,
          benefit_cost_fen: 0,
        })),
      }), checkedAt);
      const report = service(database).validateBundle(ids.bundle, checkedAt);
      expect(report.valid).toBe(false);
      expect(report.issues.map((entry) => entry.code)).toContain("PROMOTION_DISCOUNT_EXCEEDS_GUARDRAIL");
    } finally {
      database.close();
    }
  });

  it("activates a newer version while retaining the older inactive history", () => {
    const database = temporaryDatabase();
    try {
      const manager = service(database);
      manager.importSource(validInput(), checkedAt);
      manager.validateBundle(ids.bundle, checkedAt);
      manager.activateBundle({
        bundle_id: ids.bundle,
        activated_at: checkedAt,
        approved_by: "A",
        approval_note: "activate version one",
      });

      const secondBundleId = "40000000-0000-4000-8000-000000000021";
      const secondSupplierId = "40000000-0000-4000-8000-000000000022";
      const secondPromotionId = "40000000-0000-4000-8000-000000000023";
      const secondFixtureId = "40000000-0000-4000-8000-000000000024";
      const base = validInput();
      const secondRules = JSON.parse(sampleRules).map((rule: Record<string, unknown>) => ({ ...rule, version: 2 }));
      manager.importSource(validInput({
        content: JSON.stringify(secondRules),
        metadata: {
          ...base.metadata,
          bundle_id: secondBundleId,
          source_version: "0.2.1",
          reconciliation_fixture_ids: [secondFixtureId],
        },
        guardrails: base.guardrails.map((guardrail) => ({
          ...guardrail,
          supplier_quote_snapshot_refs: [secondSupplierId],
        })),
        supplier_quote_snapshots: base.supplier_quote_snapshots.map((snapshot) => ({
          ...snapshot,
          supplier_quote_snapshot_id: secondSupplierId,
          quote_version: "fixture-2",
        })),
        promotion_rules: base.promotion_rules.map((promotion) => ({
          ...promotion,
          promotion_rule_version_id: secondPromotionId,
          version: 2,
        })),
        reconciliation_cases: base.reconciliation_cases.map((fixture) => ({
          ...fixture,
          fixture_id: secondFixtureId,
        })),
      }), checkedAt);
      expect(manager.validateBundle(secondBundleId, checkedAt).valid).toBe(true);
      manager.activateBundle({
        bundle_id: secondBundleId,
        activated_at: checkedAt,
        approved_by: "A",
        approval_note: "activate version two",
      });
      expect(database.prepare(`SELECT version, status FROM rule_versions
        WHERE rule_id = 'FIXTURE-BEIJING-DESIGN-STANDARD' ORDER BY version`).all()).toEqual([
        { version: 1, status: "inactive" },
        { version: 2, status: "active" },
      ]);
    } finally {
      database.close();
    }
  });

  it("rolls back the entire activation when an injected step fails", () => {
    const database = temporaryDatabase();
    try {
      const manager = service(database, (boundary, step) => {
        if (boundary === "rule_activation" && step === "target_versions_activated") {
          throw new Error("injected activation failure");
        }
      });
      manager.importSource(validInput(), checkedAt);
      manager.validateBundle(ids.bundle, checkedAt);
      expect(() => manager.activateBundle({
        bundle_id: ids.bundle,
        activated_at: checkedAt,
        approved_by: "A",
        approval_note: "rollback test",
      })).toThrow("injected activation failure");
      expect(database.prepare("SELECT status FROM rule_import_bundles WHERE bundle_id = ?").get(ids.bundle))
        .toEqual({ status: "validated" });
      expect(database.prepare("SELECT status FROM rule_versions").get()).toEqual({ status: "validated" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM rule_activation_audit").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("refuses activation when supplier evidence expires after validation", () => {
    const database = temporaryDatabase();
    try {
      const manager = service(database);
      manager.importSource(validInput(), checkedAt);
      manager.validateBundle(ids.bundle, checkedAt);
      expect(() => manager.activateBundle({
        bundle_id: ids.bundle,
        activated_at: "2027-01-01T00:00:00Z",
        approved_by: "A",
        approval_note: "must fail",
      })).toThrow(RuleActivationError);
    } finally {
      database.close();
    }
  });
});
