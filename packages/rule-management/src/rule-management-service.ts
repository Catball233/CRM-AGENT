import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  RuleActivationResultSchema,
  RuleDefinitionSchema,
  RuleImportBundleSchema,
  RuleImportResultSchema,
  RuleValidationIssueSchema,
} from "@crm-agent/contracts";
import { z } from "zod";
import {
  RuleActivationInputSchema,
  RuleCatalogSchema,
  RuleImportSourceSchema,
  RuleValidationReportSchema,
  type RuleActivationInput,
  type RuleCatalog,
  type RuleImportSource,
  type RuleManagementHooks,
  type RuleValidationReport,
} from "./schemas";

type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;
type RuleValidationIssue = z.infer<typeof RuleValidationIssueSchema>;

type Row = Record<string, unknown>;

export class RuleImportValidationError extends Error {
  constructor(public readonly issues: RuleValidationIssue[]) {
    super("Rule import failed validation");
  }
}

export class RuleActivationError extends Error {
  constructor(public readonly issues: RuleValidationIssue[]) {
    super("Rule activation was rejected");
  }
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  if (database.isTransaction) return action();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function deterministicUuid(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function issue(code: string, message: string, ruleId?: string): RuleValidationIssue {
  return RuleValidationIssueSchema.parse({
    ...(ruleId ? { rule_id: ruleId } : {}),
    code,
    message,
    severity: "error",
  });
}

function zodIssues(error: z.ZodError): RuleValidationIssue[] {
  return error.issues.map((entry) => issue(
    "SCHEMA_INVALID",
    `${entry.path.length > 0 ? entry.path.join(".") : "input"}: ${entry.message}`,
  ));
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  values.push(current.trim());
  return values;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric CSV value: ${value}`);
  return parsed;
}

function parseCsv(content: string): unknown[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const headerLine = lines.shift();
  if (!headerLine) throw new Error("CSV has no header");
  const headers = parseCsvLine(headerLine);
  return lines.map((line, rowIndex) => {
    const values = parseCsvLine(line);
    if (values.length !== headers.length) throw new Error(`CSV row ${rowIndex + 2} has the wrong number of columns`);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    let conditions: unknown;
    try {
      conditions = JSON.parse(row.conditions_json || "{}");
    } catch {
      throw new Error(`CSV row ${rowIndex + 2} has invalid conditions_json`);
    }
    return {
      rule_id: row.rule_id,
      version: optionalNumber(row.version),
      city: row.city,
      calculation_type: row.calculation_type,
      ...(row.amount_fen ? { amount_fen: optionalNumber(row.amount_fen) } : {}),
      ...(row.unit_price_fen ? { unit_price_fen: optionalNumber(row.unit_price_fen) } : {}),
      ...(row.coefficient ? { coefficient: optionalNumber(row.coefficient) } : {}),
      ...(row.base_rule_id ? { base_rule_id: row.base_rule_id } : {}),
      ...(row.minimum_price_fen ? { minimum_price_fen: optionalNumber(row.minimum_price_fen) } : {}),
      conditions,
      ...(row.conflict_group ? { conflict_group: row.conflict_group } : {}),
      effective_from: row.effective_from,
      ...(row.effective_to ? { effective_to: row.effective_to } : {}),
    };
  });
}

function parseRules(format: "json" | "csv" | "markdown", content: string): RuleDefinition[] {
  let raw: unknown;
  try {
    if (format === "csv") raw = parseCsv(content);
    else if (format === "markdown") {
      const match = /```json\s*([\s\S]*?)```/i.exec(content);
      if (!match?.[1]) throw new Error("Markdown must contain one fenced json rule array");
      raw = JSON.parse(match[1]);
    } else raw = JSON.parse(content);
  } catch (error) {
    throw new RuleImportValidationError([
      issue("SOURCE_PARSE_FAILED", error instanceof Error ? error.message : "Unable to parse rule source"),
    ]);
  }
  const parsed = RuleDefinitionSchema.array().min(1).max(500).safeParse(raw);
  if (!parsed.success) throw new RuleImportValidationError(zodIssues(parsed.error));
  return parsed.data;
}

function rowString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid ${key} in SQLite row`);
  return value;
}

function rowNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Invalid ${key} in SQLite row`);
  return value;
}

function windowsOverlap(leftFrom: string, leftTo: string | null, rightFrom: string, rightTo: string | null): boolean {
  const leftEnd = leftTo ? Date.parse(leftTo) : Number.POSITIVE_INFINITY;
  const rightEnd = rightTo ? Date.parse(rightTo) : Number.POSITIVE_INFINITY;
  return Date.parse(leftFrom) < rightEnd && Date.parse(rightFrom) < leftEnd;
}

export function floorRevenueFen(totalCostFen: number, minimumMarginBps: number): number {
  const cost = BigInt(totalCostFen);
  const denominator = BigInt(10_000 - minimumMarginBps);
  const numerator = cost * 10_000n;
  const result = (numerator + denominator - 1n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("floor revenue exceeds safe integer range");
  return Number(result);
}

export class RuleManagementService {
  private readonly catalog: RuleCatalog;

  constructor(
    private readonly database: DatabaseSync,
    catalog: RuleCatalog,
    private readonly hooks?: RuleManagementHooks,
  ) {
    this.catalog = RuleCatalogSchema.parse(catalog);
  }

  importSource(input: RuleImportSource, importedAt = new Date().toISOString()) {
    const parsed = RuleImportSourceSchema.safeParse(input);
    if (!parsed.success) throw new RuleImportValidationError(zodIssues(parsed.error));
    const rules = parseRules(parsed.data.format, parsed.data.content);
    const bundle = RuleImportBundleSchema.parse({ ...parsed.data.metadata, rules });
    const duplicateRuleIds = rules.filter(
      (rule, index) => rules.findIndex((candidate) => candidate.rule_id === rule.rule_id) !== index,
    );
    if (duplicateRuleIds.length > 0) {
      throw new RuleImportValidationError(duplicateRuleIds.map((rule) =>
        issue("DUPLICATE_RULE_ID", "A bundle cannot contain two versions of the same rule", rule.rule_id)));
    }
    const existingVersions = rules.filter((rule) => this.database.prepare(
      "SELECT 1 FROM rule_versions WHERE rule_id = ? AND version = ?",
    ).get(rule.rule_id, rule.version));
    if (existingVersions.length > 0) {
      throw new RuleImportValidationError(existingVersions.map((rule) =>
        issue("RULE_VERSION_EXISTS", `Rule version ${rule.version} already exists`, rule.rule_id)));
    }
    const guardrailByRuleId = new Map(parsed.data.guardrails.map((value) => [value.rule_id, value]));
    const ruleVersionIds = new Map(
      rules.map((rule) => [rule.rule_id, deterministicUuid(bundle.bundle_id, rule.rule_id, String(rule.version))]),
    );

    return transaction(this.database, () => {
      this.database.prepare(`INSERT INTO rule_import_bundles (
        bundle_id, contract_version, source_format, source_document, source_version,
        fixture_owner, fixture_reviewer, reconciliation_fixture_ids_json, status, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`)
        .run(
          bundle.bundle_id, bundle.contract_version, parsed.data.format, bundle.source_document,
          bundle.source_version, bundle.fixture_owner, bundle.fixture_reviewer,
          JSON.stringify(bundle.reconciliation_fixture_ids), importedAt,
        );

      for (const rule of rules) {
        const ruleVersionId = ruleVersionIds.get(rule.rule_id);
        if (!ruleVersionId) throw new Error(`No generated version id for ${rule.rule_id}`);
        this.database.prepare(`INSERT INTO rule_versions (
          rule_version_id, rule_id, version, status, city, calculation_type, amount_fen,
          unit_price_fen, coefficient, base_rule_id, minimum_price_fen, conditions_json,
          conflict_group, effective_from, effective_to, source_document, source_version,
          fixture_owner, fixture_reviewer, created_at, validated_at, activated_at
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
          .run(
            ruleVersionId, rule.rule_id, rule.version, rule.city, rule.calculation_type,
            rule.amount_fen ?? null, rule.unit_price_fen ?? null, rule.coefficient ?? null,
            rule.base_rule_id ?? null, rule.minimum_price_fen ?? null, JSON.stringify(rule.conditions),
            rule.conflict_group ?? null, rule.effective_from, rule.effective_to ?? null,
            bundle.source_document, bundle.source_version, bundle.fixture_owner, bundle.fixture_reviewer,
            importedAt,
          );
        this.database.prepare("INSERT INTO rule_import_members (bundle_id, rule_version_id) VALUES (?, ?)")
          .run(bundle.bundle_id, ruleVersionId);
        const guardrail = guardrailByRuleId.get(rule.rule_id);
        if (guardrail) {
          this.database.prepare(`INSERT INTO rule_guardrails (
            rule_version_id, minimum_margin_bps, maximum_discount_bps, cost_rule_refs_json,
            supplier_quote_snapshot_refs_json, gift_cost_fen, free_service_cost_fen
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(
              ruleVersionId, guardrail.minimum_margin_bps, guardrail.maximum_discount_bps,
              JSON.stringify(guardrail.cost_rule_refs),
              JSON.stringify(guardrail.supplier_quote_snapshot_refs),
              guardrail.gift_cost_fen, guardrail.free_service_cost_fen,
            );
        }
      }
      this.hooks?.afterStep?.("rule_import", "rules_inserted");

      for (const evidence of parsed.data.source_evidence) {
        this.database.prepare(`INSERT INTO rule_source_evidence (
          bundle_id, source_ref, document_version, chunk_id, candidate_rule_ids_json
        ) VALUES (?, ?, ?, ?, ?)`)
          .run(
            bundle.bundle_id, evidence.source_ref, evidence.document_version,
            evidence.chunk_id, JSON.stringify(evidence.candidate_rule_ids),
          );
      }
      for (const snapshot of parsed.data.supplier_quote_snapshots) {
        this.database.prepare(`INSERT INTO supplier_quote_snapshots (
          supplier_quote_snapshot_id, bundle_id, supplier_ref, quote_version, region,
          currency, valid_from, valid_to, captured_at, items_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            snapshot.supplier_quote_snapshot_id, bundle.bundle_id, snapshot.supplier_ref,
            snapshot.quote_version, snapshot.region, snapshot.currency, snapshot.valid_from,
            snapshot.valid_to, snapshot.captured_at, JSON.stringify(snapshot.items),
          );
      }
      for (const promotion of parsed.data.promotion_rules) {
        this.database.prepare(`INSERT INTO promotion_rule_versions (
          promotion_rule_version_id, bundle_id, promotion_id, version, status, city,
          intent_levels_json, benefit_type, discount_bps, benefit_cost_fen,
          minimum_subtotal_fen, priority, exclusion_group, stackable, effective_from, effective_to
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            promotion.promotion_rule_version_id, bundle.bundle_id, promotion.promotion_id,
            promotion.version, promotion.city, JSON.stringify(promotion.intent_levels),
            promotion.benefit_type, promotion.discount_bps ?? null, promotion.benefit_cost_fen,
            promotion.minimum_subtotal_fen, promotion.priority, promotion.exclusion_group ?? null,
            promotion.stackable ? 1 : 0, promotion.effective_from, promotion.effective_to ?? null,
          );
      }
      for (const fixture of parsed.data.reconciliation_cases) {
        this.database.prepare(`INSERT INTO rule_reconciliation_cases (
          fixture_id, bundle_id, total_cost_fen, subtotal_fen, requested_discount_fen,
          minimum_margin_bps, expected_allowed
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(
            fixture.fixture_id, bundle.bundle_id, fixture.total_cost_fen, fixture.subtotal_fen,
            fixture.requested_discount_fen, fixture.minimum_margin_bps, fixture.expected_allowed ? 1 : 0,
          );
      }
      this.hooks?.afterStep?.("rule_import", "supporting_records_inserted");
      return RuleImportResultSchema.parse({
        bundle_id: bundle.bundle_id,
        candidate_rule_version_ids: [...ruleVersionIds.values()],
      });
    });
  }

  validateBundle(bundleId: string, validatedAt = new Date().toISOString()): RuleValidationReport {
    const issues = this.collectIssues(bundleId, validatedAt);
    const valid = issues.every((entry) => entry.severity !== "error");
    transaction(this.database, () => {
      this.database.prepare(`UPDATE rule_import_bundles SET
        status = ?, validated_at = ?, validation_issues_json = ? WHERE bundle_id = ?`)
        .run(valid ? "validated" : "draft", valid ? validatedAt : null, JSON.stringify(issues), bundleId);
      if (valid) {
        this.database.prepare(`UPDATE rule_versions SET status = 'validated', validated_at = ?
          WHERE rule_version_id IN (SELECT rule_version_id FROM rule_import_members WHERE bundle_id = ?)
            AND status = 'draft'`)
          .run(validatedAt, bundleId);
        this.database.prepare(`UPDATE promotion_rule_versions SET status = 'validated', validated_at = ?
          WHERE bundle_id = ? AND status = 'draft'`)
          .run(validatedAt, bundleId);
      }
      this.hooks?.afterStep?.("rule_validation", valid ? "bundle_validated" : "bundle_rejected");
    });
    return RuleValidationReportSchema.parse({ bundle_id: bundleId, valid, issues });
  }

  activateBundle(input: RuleActivationInput) {
    const activation = RuleActivationInputSchema.parse(input);
    const bundle = this.database.prepare("SELECT status FROM rule_import_bundles WHERE bundle_id = ?")
      .get(activation.bundle_id) as Row | undefined;
    if (!bundle) throw new Error("rule import bundle was not found");
    if (rowString(bundle, "status") !== "validated") {
      throw new RuleActivationError([issue("BUNDLE_NOT_VALIDATED", "Only a validated bundle can be activated")]);
    }
    const issues = this.collectActivationIssues(activation.bundle_id, activation.activated_at);
    if (issues.length > 0) throw new RuleActivationError(issues);

    const ruleRows = this.ruleRows(activation.bundle_id);
    return transaction(this.database, () => {
      for (const row of ruleRows) {
        this.database.prepare("UPDATE rule_versions SET status = 'inactive' WHERE rule_id = ? AND status = 'active'")
          .run(rowString(row, "rule_id"));
      }
      this.hooks?.afterStep?.("rule_activation", "previous_versions_deactivated");
      for (const row of ruleRows) {
        const updated = this.database.prepare(`UPDATE rule_versions SET status = 'active', activated_at = ?
          WHERE rule_version_id = ? AND status = 'validated'`)
          .run(activation.activated_at, rowString(row, "rule_version_id"));
        if (updated.changes !== 1) throw new Error("rule activation did not update exactly one target version");
      }
      this.hooks?.afterStep?.("rule_activation", "target_versions_activated");

      const promotions = this.database.prepare(
        "SELECT promotion_id FROM promotion_rule_versions WHERE bundle_id = ? AND status = 'validated'",
      ).all(activation.bundle_id) as Row[];
      for (const promotion of promotions) {
        this.database.prepare(
          "UPDATE promotion_rule_versions SET status = 'inactive' WHERE promotion_id = ? AND status = 'active'",
        ).run(rowString(promotion, "promotion_id"));
      }
      this.database.prepare(`UPDATE promotion_rule_versions SET status = 'active', activated_at = ?
        WHERE bundle_id = ? AND status = 'validated'`)
        .run(activation.activated_at, activation.bundle_id);
      this.database.prepare(`UPDATE rule_import_bundles SET status = 'active', activated_at = ?
        WHERE bundle_id = ? AND status = 'validated'`)
        .run(activation.activated_at, activation.bundle_id);
      this.database.prepare(`INSERT INTO rule_activation_audit (
        activation_id, bundle_id, approved_by, approval_note, activated_at
      ) VALUES (?, ?, ?, ?, ?)`)
        .run(randomUUID(), activation.bundle_id, activation.approved_by, activation.approval_note, activation.activated_at);
      this.hooks?.afterStep?.("rule_activation", "activation_audited");
      return RuleActivationResultSchema.parse({
        activated_rule_version_ids: ruleRows.map((row) => rowString(row, "rule_version_id")),
        rejected_rule_version_ids: [],
        issues: [],
      });
    });
  }

  private ruleRows(bundleId: string): Row[] {
    return this.database.prepare(`SELECT rule_versions.* FROM rule_versions
      JOIN rule_import_members USING (rule_version_id)
      WHERE rule_import_members.bundle_id = ? ORDER BY rule_versions.rule_id`)
      .all(bundleId) as Row[];
  }

  private collectIssues(bundleId: string, checkedAt: string): RuleValidationIssue[] {
    const bundle = this.database.prepare("SELECT * FROM rule_import_bundles WHERE bundle_id = ?")
      .get(bundleId) as Row | undefined;
    if (!bundle) throw new Error("rule import bundle was not found");
    const rows = this.ruleRows(bundleId);
    const issues: RuleValidationIssue[] = [];
    const rules = rows.map((row) => RuleDefinitionSchema.parse({
      rule_id: rowString(row, "rule_id"),
      version: rowNumber(row, "version"),
      city: rowString(row, "city"),
      calculation_type: rowString(row, "calculation_type"),
      ...(row.amount_fen === null ? {} : { amount_fen: rowNumber(row, "amount_fen") }),
      ...(row.unit_price_fen === null ? {} : { unit_price_fen: rowNumber(row, "unit_price_fen") }),
      ...(row.coefficient === null ? {} : { coefficient: rowNumber(row, "coefficient") }),
      ...(row.base_rule_id === null ? {} : { base_rule_id: rowString(row, "base_rule_id") }),
      ...(row.minimum_price_fen === null ? {} : { minimum_price_fen: rowNumber(row, "minimum_price_fen") }),
      conditions: JSON.parse(rowString(row, "conditions_json")),
      ...(row.conflict_group === null ? {} : { conflict_group: rowString(row, "conflict_group") }),
      effective_from: rowString(row, "effective_from"),
      ...(row.effective_to === null ? {} : { effective_to: rowString(row, "effective_to") }),
    }));
    const ruleIds = new Set(rules.map((rule) => rule.rule_id));
    const seenRuleIds = new Set<string>();
    const conditionsCatalog: Record<string, Set<string>> = {
      scene: new Set(this.catalog.scenes),
      trade: new Set(this.catalog.trades),
      material_tier: new Set(this.catalog.material_tiers),
      designer_tier: new Set(this.catalog.designer_tiers),
    };
    for (const rule of rules) {
      if (seenRuleIds.has(rule.rule_id)) issues.push(issue("DUPLICATE_RULE_ID", "A bundle cannot contain two versions of the same rule", rule.rule_id));
      seenRuleIds.add(rule.rule_id);
      if (!this.catalog.cities.includes(rule.city)) issues.push(issue("UNKNOWN_CITY", `Unknown city: ${rule.city}`, rule.rule_id));
      if (rule.effective_to && Date.parse(rule.effective_to) <= Date.parse(checkedAt)) {
        issues.push(issue("RULE_EXPIRED", "Rule effective period has already ended", rule.rule_id));
      }
      for (const [key, allowed] of Object.entries(conditionsCatalog)) {
        const value = rule.conditions[key];
        if (typeof value === "string" && !allowed.has(value)) {
          issues.push(issue("UNKNOWN_CONDITION", `Unknown ${key}: ${value}`, rule.rule_id));
        }
      }
      if (rule.base_rule_id && !ruleIds.has(rule.base_rule_id)) {
        const found = this.database.prepare("SELECT 1 FROM rule_versions WHERE rule_id = ? LIMIT 1").get(rule.base_rule_id);
        if (!found) issues.push(issue("BASE_RULE_MISSING", `Base rule ${rule.base_rule_id} was not found`, rule.rule_id));
      }
      const guardrail = this.database.prepare(`SELECT * FROM rule_guardrails
        WHERE rule_version_id = (SELECT rule_version_id FROM rule_versions
          WHERE rule_id = ? AND rule_version_id IN (
            SELECT rule_version_id FROM rule_import_members WHERE bundle_id = ?
          ))`).get(rule.rule_id, bundleId) as Row | undefined;
      if (!guardrail) {
        issues.push(issue("GUARDRAIL_MISSING", "Every imported rule requires a profit guardrail", rule.rule_id));
      } else {
        const costRefs = JSON.parse(rowString(guardrail, "cost_rule_refs_json")) as string[];
        for (const ref of costRefs) {
          if (!ruleIds.has(ref) && !this.database.prepare("SELECT 1 FROM rule_versions WHERE rule_id = ? LIMIT 1").get(ref)) {
            issues.push(issue("COST_RULE_MISSING", `Cost rule ${ref} was not found`, rule.rule_id));
          }
        }
        const snapshotRefs = JSON.parse(rowString(guardrail, "supplier_quote_snapshot_refs_json")) as string[];
        for (const ref of snapshotRefs) {
          const snapshot = this.database.prepare("SELECT * FROM supplier_quote_snapshots WHERE supplier_quote_snapshot_id = ?")
            .get(ref) as Row | undefined;
          if (!snapshot) issues.push(issue("SUPPLIER_QUOTE_MISSING", `Supplier quote ${ref} was not found`, rule.rule_id));
          else {
            if (rowString(snapshot, "region") !== rule.city) issues.push(issue("SUPPLIER_REGION_MISMATCH", `Supplier quote ${ref} is for another region`, rule.rule_id));
            if (Date.parse(rowString(snapshot, "valid_from")) > Date.parse(checkedAt) || Date.parse(rowString(snapshot, "valid_to")) <= Date.parse(checkedAt)) {
              issues.push(issue("SUPPLIER_QUOTE_EXPIRED", `Supplier quote ${ref} is not valid at validation time`, rule.rule_id));
            }
          }
        }
      }
      const evidence = this.database.prepare("SELECT candidate_rule_ids_json FROM rule_source_evidence WHERE bundle_id = ?")
        .all(bundleId) as Row[];
      if (!evidence.some((entry) => (JSON.parse(rowString(entry, "candidate_rule_ids_json")) as string[]).includes(rule.rule_id))) {
        issues.push(issue("SOURCE_EVIDENCE_MISSING", "Rule is not traceable to imported source evidence", rule.rule_id));
      }
    }

    for (let left = 0; left < rules.length; left += 1) {
      for (let right = left + 1; right < rules.length; right += 1) {
        const first = rules[left];
        const second = rules[right];
        if (!first || !second || !first.conflict_group || first.conflict_group !== second.conflict_group || first.city !== second.city) continue;
        if (windowsOverlap(first.effective_from, first.effective_to ?? null, second.effective_from, second.effective_to ?? null)) {
          issues.push(issue("CONFLICT_GROUP_OVERLAP", `Conflicts with ${second.rule_id} in ${first.conflict_group}`, first.rule_id));
        }
      }
    }

    const expectedFixtureIds = new Set(JSON.parse(rowString(bundle, "reconciliation_fixture_ids_json")) as string[]);
    const fixtures = this.database.prepare("SELECT * FROM rule_reconciliation_cases WHERE bundle_id = ?")
      .all(bundleId) as Row[];
    const actualFixtureIds = new Set(fixtures.map((row) => rowString(row, "fixture_id")));
    for (const id of expectedFixtureIds) if (!actualFixtureIds.has(id)) issues.push(issue("RECONCILIATION_FIXTURE_MISSING", `Fixture ${id} was not imported`));
    for (const fixture of fixtures) {
      const floor = floorRevenueFen(rowNumber(fixture, "total_cost_fen"), rowNumber(fixture, "minimum_margin_bps"));
      const finalRevenue = rowNumber(fixture, "subtotal_fen") - rowNumber(fixture, "requested_discount_fen");
      const actualAllowed = finalRevenue >= floor;
      if (actualAllowed !== (rowNumber(fixture, "expected_allowed") === 1)) {
        issues.push(issue("PROFIT_FLOOR_FIXTURE_MISMATCH", `Fixture ${rowString(fixture, "fixture_id")} contradicts the profit floor`));
      }
    }

    const promotions = this.database.prepare("SELECT * FROM promotion_rule_versions WHERE bundle_id = ?")
      .all(bundleId) as Row[];
    for (const promotion of promotions) {
      if (!this.catalog.cities.includes(rowString(promotion, "city"))) {
        issues.push(issue("UNKNOWN_PROMOTION_CITY", `Unknown promotion city: ${rowString(promotion, "city")}`));
      }
      const effectiveTo = promotion.effective_to === null ? null : rowString(promotion, "effective_to");
      if (effectiveTo && Date.parse(effectiveTo) <= Date.parse(checkedAt)) {
        issues.push(issue("PROMOTION_EXPIRED", `Promotion ${rowString(promotion, "promotion_id")} has expired`));
      }
      if (rowString(promotion, "benefit_type") === "cash_discount" && promotion.discount_bps !== null) {
        const cityMaximums = rows
          .filter((rule) => rowString(rule, "city") === rowString(promotion, "city"))
          .flatMap((rule) => {
            const guardrail = this.database.prepare(
              "SELECT maximum_discount_bps FROM rule_guardrails WHERE rule_version_id = ?",
            ).get(rowString(rule, "rule_version_id")) as Row | undefined;
            return guardrail ? [rowNumber(guardrail, "maximum_discount_bps")] : [];
          });
        const maximumAllowed = cityMaximums.length > 0 ? Math.min(...cityMaximums) : 0;
        if (rowNumber(promotion, "discount_bps") > maximumAllowed) {
          issues.push(issue(
            "PROMOTION_DISCOUNT_EXCEEDS_GUARDRAIL",
            `Promotion ${rowString(promotion, "promotion_id")} exceeds the strictest city discount limit`,
          ));
        }
      }
    }
    for (let left = 0; left < promotions.length; left += 1) {
      for (let right = left + 1; right < promotions.length; right += 1) {
        const first = promotions[left];
        const second = promotions[right];
        if (!first || !second || first.exclusion_group === null || first.exclusion_group !== second.exclusion_group) continue;
        const overlaps = windowsOverlap(
          rowString(first, "effective_from"),
          first.effective_to === null ? null : rowString(first, "effective_to"),
          rowString(second, "effective_from"),
          second.effective_to === null ? null : rowString(second, "effective_to"),
        );
        if (overlaps) {
          issues.push(issue(
            "PROMOTION_EXCLUSION_CONFLICT",
            `Promotions ${rowString(first, "promotion_id")} and ${rowString(second, "promotion_id")} overlap in one exclusion group`,
          ));
        }
      }
    }
    return issues;
  }

  private collectActivationIssues(bundleId: string, activatedAt: string): RuleValidationIssue[] {
    const issues: RuleValidationIssue[] = [];
    for (const row of this.ruleRows(bundleId)) {
      const ruleId = rowString(row, "rule_id");
      const effectiveTo = row.effective_to === null ? null : rowString(row, "effective_to");
      if (Date.parse(rowString(row, "effective_from")) > Date.parse(activatedAt) || (effectiveTo && Date.parse(effectiveTo) <= Date.parse(activatedAt))) {
        issues.push(issue("RULE_NOT_EFFECTIVE", "Rule is not effective at activation time", ruleId));
      }
      const snapshots = this.database.prepare(`SELECT supplier_quote_snapshot_refs_json FROM rule_guardrails
        WHERE rule_version_id = ?`).get(rowString(row, "rule_version_id")) as Row | undefined;
      if (snapshots) {
        for (const ref of JSON.parse(rowString(snapshots, "supplier_quote_snapshot_refs_json")) as string[]) {
          const snapshot = this.database.prepare("SELECT valid_from, valid_to FROM supplier_quote_snapshots WHERE supplier_quote_snapshot_id = ?")
            .get(ref) as Row | undefined;
          if (!snapshot || Date.parse(rowString(snapshot, "valid_from")) > Date.parse(activatedAt) || Date.parse(rowString(snapshot, "valid_to")) <= Date.parse(activatedAt)) {
            issues.push(issue("SUPPLIER_QUOTE_EXPIRED", `Supplier quote ${ref} is not valid at activation time`, ruleId));
          }
        }
      }
      if (row.conflict_group !== null) {
        const conflicts = this.database.prepare(`SELECT rule_id FROM rule_versions
          WHERE status = 'active' AND city = ? AND conflict_group = ? AND rule_id <> ?
            AND datetime(effective_from) < datetime(COALESCE(?, '9999-12-31T23:59:59Z'))
            AND datetime(?) < datetime(COALESCE(effective_to, '9999-12-31T23:59:59Z'))`)
          .all(
            rowString(row, "city"), rowString(row, "conflict_group"), ruleId,
            effectiveTo, rowString(row, "effective_from"),
          ) as Row[];
        for (const conflict of conflicts) {
          issues.push(issue("ACTIVE_RULE_CONFLICT", `Conflicts with active rule ${rowString(conflict, "rule_id")}`, ruleId));
        }
      }
    }
    const promotions = this.database.prepare("SELECT * FROM promotion_rule_versions WHERE bundle_id = ?")
      .all(bundleId) as Row[];
    for (const promotion of promotions) {
      const effectiveTo = promotion.effective_to === null ? null : rowString(promotion, "effective_to");
      if (
        Date.parse(rowString(promotion, "effective_from")) > Date.parse(activatedAt)
        || (effectiveTo && Date.parse(effectiveTo) <= Date.parse(activatedAt))
      ) {
        issues.push(issue(
          "PROMOTION_NOT_EFFECTIVE",
          `Promotion ${rowString(promotion, "promotion_id")} is not effective at activation time`,
        ));
      }
      if (promotion.exclusion_group !== null) {
        const activeConflict = this.database.prepare(`SELECT promotion_id FROM promotion_rule_versions
          WHERE status = 'active' AND city = ? AND exclusion_group = ? AND promotion_id <> ?
          LIMIT 1`).get(
            rowString(promotion, "city"), rowString(promotion, "exclusion_group"),
            rowString(promotion, "promotion_id"),
          ) as Row | undefined;
        if (activeConflict) {
          issues.push(issue(
            "ACTIVE_PROMOTION_CONFLICT",
            `Conflicts with active promotion ${rowString(activeConflict, "promotion_id")}`,
          ));
        }
      }
    }
    return issues;
  }
}
