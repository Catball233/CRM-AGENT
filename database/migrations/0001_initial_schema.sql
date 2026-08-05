CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY CHECK (length(conversation_id) = 36),
  contract_version TEXT NOT NULL DEFAULT '1.0.0' CHECK (contract_version = '1.0.0'),
  stage TEXT NOT NULL CHECK (stage IN ('DISCOVERY', 'QUALIFYING', 'QUOTING', 'NEGOTIATION', 'COMPLETED', 'CLOSED')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CLOSED')),
  created_at TEXT NOT NULL CHECK (datetime(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (datetime(updated_at) IS NOT NULL),
  CHECK (datetime(updated_at) >= datetime(created_at))
) STRICT;

CREATE TABLE turns (
  turn_id TEXT PRIMARY KEY CHECK (length(turn_id) = 36),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL CHECK (length(client_message_id) = 36),
  retry_request_id TEXT CHECK (retry_request_id IS NULL OR length(retry_request_id) = 36),
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('answer', 'question', 'quote', 'safe_stop')),
  started_at TEXT NOT NULL CHECK (datetime(started_at) IS NOT NULL),
  completed_at TEXT CHECK (completed_at IS NULL OR datetime(completed_at) IS NOT NULL),
  failure_code TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array'),
  UNIQUE (conversation_id, client_message_id),
  UNIQUE (conversation_id, retry_request_id),
  CHECK ((status = 'PROCESSING' AND completed_at IS NULL) OR (status <> 'PROCESSING' AND completed_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR datetime(completed_at) >= datetime(started_at))
) STRICT;

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY CHECK (length(message_id) = 36),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  cited_evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cited_evidence_ids_json) AND json_type(cited_evidence_ids_json) = 'array'),
  created_at TEXT NOT NULL CHECK (datetime(created_at) IS NOT NULL),
  UNIQUE (conversation_id, sequence)
) STRICT;

CREATE TABLE memory_summaries (
  summary_id TEXT PRIMARY KEY CHECK (length(summary_id) = 36),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  summary_text TEXT NOT NULL CHECK (length(summary_text) BETWEEN 1 AND 8000),
  covers_sequence_from INTEGER NOT NULL CHECK (covers_sequence_from > 0),
  covers_sequence_to INTEGER NOT NULL CHECK (covers_sequence_to >= covers_sequence_from),
  source_message_ids_json TEXT NOT NULL CHECK (json_valid(source_message_ids_json) AND json_type(source_message_ids_json) = 'array'),
  created_at TEXT NOT NULL CHECK (datetime(created_at) IS NOT NULL),
  UNIQUE (conversation_id, version)
) STRICT;

CREATE TABLE customer_facts (
  fact_id TEXT PRIMARY KEY CHECK (length(fact_id) = 36),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL CHECK (fact_key IN (
    'city', 'area_sqm', 'layout', 'house_state', 'service_scope', 'designer_tier',
    'material_tier', 'budget_max_fen', 'expected_start_date', 'quantities',
    'special_requirements', 'preference', 'concern', 'decision_timeline'
  )),
  category TEXT NOT NULL CHECK (category IN ('requirement', 'preference', 'concern', 'sales_signal')),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'inferred', 'conflicted')),
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0.0 AND 1.0),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json) AND json_type(source_refs_json) = 'array'),
  updated_at TEXT NOT NULL CHECK (datetime(updated_at) IS NOT NULL)
) STRICT;

CREATE TABLE knowledge_evidence (
  evidence_id TEXT PRIMARY KEY CHECK (length(evidence_id) = 36),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
  contract_version TEXT NOT NULL DEFAULT '1.0.0' CHECK (contract_version = '1.0.0'),
  knowledge_base_id TEXT NOT NULL CHECK (length(knowledge_base_id) BETWEEN 1 AND 200),
  document_id TEXT NOT NULL CHECK (length(document_id) BETWEEN 1 AND 200),
  document_version TEXT NOT NULL CHECK (length(document_version) BETWEEN 1 AND 100),
  chunk_id TEXT NOT NULL CHECK (length(chunk_id) BETWEEN 1 AND 200),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  excerpt TEXT NOT NULL CHECK (length(excerpt) BETWEEN 1 AND 2000),
  score REAL NOT NULL CHECK (score BETWEEN 0.0 AND 1.0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  candidate_rule_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_rule_ids_json) AND json_type(candidate_rule_ids_json) = 'array'),
  provider_request_id TEXT,
  created_at TEXT NOT NULL CHECK (datetime(created_at) IS NOT NULL),
  UNIQUE (turn_id, knowledge_base_id, document_id, document_version, chunk_id)
) STRICT;

CREATE TABLE rule_versions (
  rule_version_id TEXT PRIMARY KEY CHECK (length(rule_version_id) = 36),
  rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 100),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'validated', 'active', 'inactive', 'expired')),
  city TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 100),
  calculation_type TEXT NOT NULL CHECK (calculation_type IN (
    'FIXED_AMOUNT', 'AREA_MULTIPLY', 'QUANTITY_MULTIPLY', 'TIER_COEFFICIENT',
    'CONDITIONAL_SURCHARGE', 'MINIMUM_PRICE'
  )),
  amount_fen INTEGER CHECK (amount_fen IS NULL OR amount_fen BETWEEN 0 AND 9007199254740991),
  unit_price_fen INTEGER CHECK (unit_price_fen IS NULL OR unit_price_fen BETWEEN 0 AND 9007199254740991),
  coefficient REAL CHECK (coefficient IS NULL OR coefficient > 0),
  base_rule_id TEXT,
  minimum_price_fen INTEGER CHECK (minimum_price_fen IS NULL OR minimum_price_fen BETWEEN 0 AND 9007199254740991),
  conditions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(conditions_json) AND json_type(conditions_json) = 'object'),
  conflict_group TEXT,
  effective_from TEXT NOT NULL CHECK (datetime(effective_from) IS NOT NULL),
  effective_to TEXT CHECK (effective_to IS NULL OR datetime(effective_to) IS NOT NULL),
  source_document TEXT NOT NULL CHECK (length(source_document) BETWEEN 1 AND 500),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 100),
  fixture_owner TEXT NOT NULL CHECK (length(fixture_owner) BETWEEN 1 AND 100),
  fixture_reviewer TEXT NOT NULL CHECK (length(fixture_reviewer) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL CHECK (datetime(created_at) IS NOT NULL),
  validated_at TEXT CHECK (validated_at IS NULL OR datetime(validated_at) IS NOT NULL),
  activated_at TEXT CHECK (activated_at IS NULL OR datetime(activated_at) IS NOT NULL),
  UNIQUE (rule_id, version),
  CHECK (effective_to IS NULL OR datetime(effective_to) > datetime(effective_from)),
  CHECK (base_rule_id IS NULL OR base_rule_id <> rule_id),
  CHECK (
    (calculation_type = 'FIXED_AMOUNT' AND amount_fen IS NOT NULL) OR
    (calculation_type IN ('AREA_MULTIPLY', 'QUANTITY_MULTIPLY') AND unit_price_fen IS NOT NULL) OR
    (calculation_type = 'TIER_COEFFICIENT' AND coefficient IS NOT NULL AND base_rule_id IS NOT NULL) OR
    (calculation_type = 'CONDITIONAL_SURCHARGE' AND amount_fen IS NOT NULL) OR
    (calculation_type = 'MINIMUM_PRICE' AND minimum_price_fen IS NOT NULL)
  ),
  CHECK (status NOT IN ('validated', 'active') OR validated_at IS NOT NULL),
  CHECK (status <> 'active' OR activated_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX ux_rule_versions_one_active
  ON rule_versions(rule_id)
  WHERE status = 'active';

CREATE TABLE quote_versions (
  quote_id TEXT PRIMARY KEY CHECK (length(quote_id) = 36),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE RESTRICT,
  quote_version INTEGER NOT NULL CHECK (quote_version > 0),
  parent_quote_id TEXT REFERENCES quote_versions(quote_id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'estimated' CHECK (status = 'estimated'),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json) AND json_type(parameters_json) = 'object'),
  estimated_total_fen INTEGER NOT NULL CHECK (estimated_total_fen BETWEEN 0 AND 9007199254740991),
  assumptions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(assumptions_json) AND json_type(assumptions_json) = 'array'),
  exclusions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exclusions_json) AND json_type(exclusions_json) = 'array'),
  disclaimer TEXT NOT NULL CHECK (length(disclaimer) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL CHECK (datetime(created_at) IS NOT NULL),
  UNIQUE (conversation_id, quote_version),
  UNIQUE (turn_id)
) STRICT;

CREATE TABLE quote_items (
  quote_item_id TEXT PRIMARY KEY CHECK (length(quote_item_id) = 36),
  quote_id TEXT NOT NULL REFERENCES quote_versions(quote_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position > 0),
  category TEXT NOT NULL CHECK (category IN ('design', 'material', 'construction', 'surcharge', 'adjustment')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 300),
  calculation_type TEXT NOT NULL CHECK (calculation_type IN (
    'FIXED_AMOUNT', 'AREA_MULTIPLY', 'QUANTITY_MULTIPLY', 'TIER_COEFFICIENT',
    'CONDITIONAL_SURCHARGE', 'MINIMUM_PRICE'
  )),
  quantity REAL CHECK (quantity IS NULL OR quantity >= 0),
  unit TEXT CHECK (unit IS NULL OR length(unit) BETWEEN 1 AND 50),
  unit_price_fen INTEGER CHECK (unit_price_fen IS NULL OR unit_price_fen BETWEEN 0 AND 9007199254740991),
  amount_fen INTEGER NOT NULL CHECK (amount_fen BETWEEN 0 AND 9007199254740991),
  calculation_inputs_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(calculation_inputs_json) AND json_type(calculation_inputs_json) = 'object'),
  rule_version_id TEXT NOT NULL REFERENCES rule_versions(rule_version_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (datetime(created_at) IS NOT NULL),
  UNIQUE (quote_id, position)
) STRICT;

CREATE TABLE quote_knowledge_evidence (
  quote_id TEXT NOT NULL REFERENCES quote_versions(quote_id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES knowledge_evidence(evidence_id) ON DELETE RESTRICT,
  PRIMARY KEY (quote_id, evidence_id)
) STRICT;

CREATE TABLE seed_history (
  seed_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  applied_at TEXT NOT NULL CHECK (datetime(applied_at) IS NOT NULL)
) STRICT;

CREATE INDEX ix_turns_conversation_started ON turns(conversation_id, started_at);
CREATE INDEX ix_messages_conversation_created ON messages(conversation_id, created_at);
CREATE INDEX ix_customer_facts_conversation_key ON customer_facts(conversation_id, fact_key, updated_at);
CREATE INDEX ix_evidence_turn_score ON knowledge_evidence(turn_id, score DESC);
CREATE INDEX ix_rules_lookup ON rule_versions(rule_id, status, city, effective_from, effective_to);
CREATE INDEX ix_quotes_conversation_created ON quote_versions(conversation_id, created_at);
CREATE INDEX ix_quote_items_rule_version ON quote_items(rule_version_id);
