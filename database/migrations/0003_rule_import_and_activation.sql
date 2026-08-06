CREATE TABLE rule_import_bundles (
  bundle_id TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL,
  source_format TEXT NOT NULL CHECK (source_format IN ('json', 'csv', 'markdown')),
  source_document TEXT NOT NULL CHECK (length(source_document) BETWEEN 1 AND 500),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 100),
  fixture_owner TEXT NOT NULL CHECK (length(fixture_owner) BETWEEN 1 AND 100),
  fixture_reviewer TEXT NOT NULL CHECK (length(fixture_reviewer) BETWEEN 1 AND 100),
  reconciliation_fixture_ids_json TEXT NOT NULL CHECK (
    json_valid(reconciliation_fixture_ids_json)
    AND json_type(reconciliation_fixture_ids_json) = 'array'
  ),
  status TEXT NOT NULL CHECK (status IN ('draft', 'validated', 'active', 'inactive', 'rejected')),
  imported_at TEXT NOT NULL,
  validated_at TEXT,
  activated_at TEXT,
  validation_issues_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(validation_issues_json)
    AND json_type(validation_issues_json) = 'array'
  )
) STRICT;

CREATE TABLE rule_import_members (
  bundle_id TEXT NOT NULL REFERENCES rule_import_bundles(bundle_id) ON DELETE CASCADE,
  rule_version_id TEXT NOT NULL REFERENCES rule_versions(rule_version_id) ON DELETE RESTRICT,
  PRIMARY KEY (bundle_id, rule_version_id),
  UNIQUE (rule_version_id)
) STRICT;

CREATE TABLE rule_source_evidence (
  bundle_id TEXT NOT NULL REFERENCES rule_import_bundles(bundle_id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 500),
  document_version TEXT NOT NULL CHECK (length(document_version) BETWEEN 1 AND 100),
  chunk_id TEXT NOT NULL CHECK (length(chunk_id) BETWEEN 1 AND 200),
  candidate_rule_ids_json TEXT NOT NULL CHECK (
    json_valid(candidate_rule_ids_json)
    AND json_type(candidate_rule_ids_json) = 'array'
  ),
  PRIMARY KEY (bundle_id, source_ref, document_version, chunk_id)
) STRICT;

CREATE TABLE supplier_quote_snapshots (
  supplier_quote_snapshot_id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES rule_import_bundles(bundle_id) ON DELETE CASCADE,
  supplier_ref TEXT NOT NULL CHECK (length(supplier_ref) BETWEEN 1 AND 200),
  quote_version TEXT NOT NULL CHECK (length(quote_version) BETWEEN 1 AND 100),
  region TEXT NOT NULL CHECK (length(region) BETWEEN 1 AND 100),
  currency TEXT NOT NULL CHECK (currency = 'CNY'),
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  items_json TEXT NOT NULL CHECK (json_valid(items_json) AND json_type(items_json) = 'array'),
  UNIQUE (supplier_ref, quote_version),
  CHECK (datetime(valid_to) > datetime(valid_from))
) STRICT;

CREATE TABLE rule_guardrails (
  rule_version_id TEXT PRIMARY KEY REFERENCES rule_versions(rule_version_id) ON DELETE CASCADE,
  minimum_margin_bps INTEGER NOT NULL CHECK (minimum_margin_bps BETWEEN 0 AND 9999),
  maximum_discount_bps INTEGER NOT NULL CHECK (maximum_discount_bps BETWEEN 0 AND 10000),
  cost_rule_refs_json TEXT NOT NULL CHECK (json_valid(cost_rule_refs_json) AND json_type(cost_rule_refs_json) = 'array'),
  supplier_quote_snapshot_refs_json TEXT NOT NULL CHECK (
    json_valid(supplier_quote_snapshot_refs_json)
    AND json_type(supplier_quote_snapshot_refs_json) = 'array'
  ),
  gift_cost_fen INTEGER NOT NULL DEFAULT 0 CHECK (gift_cost_fen >= 0),
  free_service_cost_fen INTEGER NOT NULL DEFAULT 0 CHECK (free_service_cost_fen >= 0)
) STRICT;

CREATE TABLE promotion_rule_versions (
  promotion_rule_version_id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES rule_import_bundles(bundle_id) ON DELETE CASCADE,
  promotion_id TEXT NOT NULL CHECK (length(promotion_id) BETWEEN 1 AND 100),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'validated', 'active', 'inactive', 'expired')),
  city TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 100),
  intent_levels_json TEXT NOT NULL CHECK (json_valid(intent_levels_json) AND json_type(intent_levels_json) = 'array'),
  benefit_type TEXT NOT NULL CHECK (benefit_type IN ('cash_discount', 'gift', 'free_service')),
  discount_bps INTEGER CHECK (discount_bps IS NULL OR discount_bps BETWEEN 0 AND 10000),
  benefit_cost_fen INTEGER NOT NULL DEFAULT 0 CHECK (benefit_cost_fen >= 0),
  minimum_subtotal_fen INTEGER NOT NULL DEFAULT 0 CHECK (minimum_subtotal_fen >= 0),
  priority INTEGER NOT NULL DEFAULT 0,
  exclusion_group TEXT,
  stackable INTEGER NOT NULL DEFAULT 0 CHECK (stackable IN (0, 1)),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  validated_at TEXT,
  activated_at TEXT,
  UNIQUE (promotion_id, version),
  CHECK (effective_to IS NULL OR datetime(effective_to) > datetime(effective_from)),
  CHECK (benefit_type = 'cash_discount' OR discount_bps IS NULL)
) STRICT;

CREATE UNIQUE INDEX ux_promotion_rule_one_active
  ON promotion_rule_versions(promotion_id)
  WHERE status = 'active';

CREATE TABLE rule_reconciliation_cases (
  fixture_id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES rule_import_bundles(bundle_id) ON DELETE CASCADE,
  total_cost_fen INTEGER NOT NULL CHECK (total_cost_fen >= 0),
  subtotal_fen INTEGER NOT NULL CHECK (subtotal_fen >= 0),
  requested_discount_fen INTEGER NOT NULL CHECK (requested_discount_fen >= 0),
  minimum_margin_bps INTEGER NOT NULL CHECK (minimum_margin_bps BETWEEN 0 AND 9999),
  expected_allowed INTEGER NOT NULL CHECK (expected_allowed IN (0, 1))
) STRICT;

CREATE TABLE rule_activation_audit (
  activation_id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES rule_import_bundles(bundle_id) ON DELETE RESTRICT,
  approved_by TEXT NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 100),
  approval_note TEXT NOT NULL CHECK (length(approval_note) BETWEEN 1 AND 1000),
  activated_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_rule_import_bundles_status ON rule_import_bundles(status, imported_at);
CREATE INDEX ix_rule_import_members_bundle ON rule_import_members(bundle_id);
CREATE INDEX ix_supplier_quote_bundle_validity ON supplier_quote_snapshots(bundle_id, valid_from, valid_to);
CREATE INDEX ix_promotion_bundle_status ON promotion_rule_versions(bundle_id, status);
