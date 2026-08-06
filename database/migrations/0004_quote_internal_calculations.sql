CREATE TABLE quote_internal_calculations (
  calculation_id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL UNIQUE REFERENCES quote_versions(quote_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL UNIQUE REFERENCES turns(turn_id) ON DELETE RESTRICT,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  revenue_subtotal_fen INTEGER NOT NULL CHECK (revenue_subtotal_fen BETWEEN 0 AND 9007199254740991),
  direct_cost_fen INTEGER NOT NULL CHECK (direct_cost_fen BETWEEN 0 AND 9007199254740991),
  procurement_cost_fen INTEGER NOT NULL CHECK (procurement_cost_fen BETWEEN 0 AND 9007199254740991),
  gift_cost_fen INTEGER NOT NULL CHECK (gift_cost_fen BETWEEN 0 AND 9007199254740991),
  free_service_cost_fen INTEGER NOT NULL CHECK (free_service_cost_fen BETWEEN 0 AND 9007199254740991),
  total_cost_fen INTEGER NOT NULL CHECK (total_cost_fen BETWEEN 0 AND 9007199254740991),
  minimum_margin_bps INTEGER NOT NULL CHECK (minimum_margin_bps BETWEEN 0 AND 9999),
  floor_revenue_fen INTEGER NOT NULL CHECK (floor_revenue_fen BETWEEN 0 AND 9007199254740991),
  rule_discount_cap_fen INTEGER NOT NULL CHECK (rule_discount_cap_fen BETWEEN 0 AND 9007199254740991),
  margin_headroom_fen INTEGER NOT NULL CHECK (margin_headroom_fen BETWEEN 0 AND 9007199254740991),
  approved_discount_fen INTEGER NOT NULL CHECK (approved_discount_fen BETWEEN 0 AND 9007199254740991),
  final_revenue_fen INTEGER NOT NULL CHECK (final_revenue_fen BETWEEN 0 AND 9007199254740991),
  intent_level TEXT NOT NULL CHECK (intent_level IN ('high', 'medium', 'low', 'unknown')),
  supplier_snapshot_refs_json TEXT NOT NULL CHECK (
    json_valid(supplier_snapshot_refs_json) AND json_type(supplier_snapshot_refs_json) = 'array'
  ),
  rule_version_refs_json TEXT NOT NULL CHECK (
    json_valid(rule_version_refs_json) AND json_type(rule_version_refs_json) = 'array'
  ),
  knowledge_evidence_ids_json TEXT NOT NULL CHECK (
    json_valid(knowledge_evidence_ids_json) AND json_type(knowledge_evidence_ids_json) = 'array'
  ),
  validation_codes_json TEXT NOT NULL CHECK (
    json_valid(validation_codes_json) AND json_type(validation_codes_json) = 'array'
  ),
  valid_until TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  CHECK (final_revenue_fen = revenue_subtotal_fen - approved_discount_fen),
  CHECK (final_revenue_fen >= total_cost_fen),
  CHECK (final_revenue_fen >= floor_revenue_fen),
  CHECK (datetime(valid_until) > datetime(calculated_at))
) STRICT;

CREATE TABLE quote_internal_cost_items (
  cost_item_id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quote_internal_calculations(quote_id) ON DELETE CASCADE,
  cost_type TEXT NOT NULL CHECK (cost_type IN (
    'direct_rule', 'procurement_wholesale', 'delivery', 'installation', 'warranty',
    'gift', 'free_service'
  )),
  amount_fen INTEGER NOT NULL CHECK (amount_fen BETWEEN 0 AND 9007199254740991),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 500),
  rule_version_id TEXT REFERENCES rule_versions(rule_version_id) ON DELETE RESTRICT,
  supplier_quote_snapshot_id TEXT REFERENCES supplier_quote_snapshots(supplier_quote_snapshot_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE quote_promotion_links (
  quote_id TEXT NOT NULL REFERENCES quote_internal_calculations(quote_id) ON DELETE CASCADE,
  promotion_rule_version_id TEXT NOT NULL REFERENCES promotion_rule_versions(promotion_rule_version_id) ON DELETE RESTRICT,
  approved_discount_fen INTEGER NOT NULL DEFAULT 0 CHECK (approved_discount_fen BETWEEN 0 AND 9007199254740991),
  internal_benefit_cost_fen INTEGER NOT NULL DEFAULT 0 CHECK (internal_benefit_cost_fen BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (quote_id, promotion_rule_version_id)
) STRICT;

CREATE INDEX ix_quote_internal_turn_hash ON quote_internal_calculations(turn_id, request_hash);
CREATE INDEX ix_quote_internal_cost_quote ON quote_internal_cost_items(quote_id, cost_type);
