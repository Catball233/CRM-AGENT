CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY CHECK (
    length(conversation_id) = 36
    AND substr(conversation_id, 9, 1) = '-'
    AND substr(conversation_id, 14, 1) = '-'
    AND substr(conversation_id, 19, 1) = '-'
    AND substr(conversation_id, 24, 1) = '-'
    AND length(replace(conversation_id, '-', '')) = 32
    AND lower(replace(conversation_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
    AND (
      lower(conversation_id) IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
      OR (lower(substr(conversation_id, 15, 1)) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND lower(substr(conversation_id, 20, 1)) IN ('8', '9', 'a', 'b'))
    )
  ),
  contract_version TEXT NOT NULL DEFAULT '1.0.0' CHECK (contract_version = '1.0.0'),
  stage TEXT NOT NULL CHECK (stage IN ('DISCOVERY', 'QUALIFYING', 'QUOTING', 'NEGOTIATION', 'COMPLETED', 'CLOSED')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CLOSED')),
  created_at TEXT NOT NULL CHECK (
    datetime(created_at) IS NOT NULL
    AND created_at GLOB '????-??-??T??:??:??*'
    AND (substr(created_at, -1) = 'Z' OR (substr(created_at, -6, 1) IN ('+', '-') AND substr(created_at, -3, 1) = ':'))
  ),
  updated_at TEXT NOT NULL CHECK (
    datetime(updated_at) IS NOT NULL
    AND updated_at GLOB '????-??-??T??:??:??*'
    AND (substr(updated_at, -1) = 'Z' OR (substr(updated_at, -6, 1) IN ('+', '-') AND substr(updated_at, -3, 1) = ':'))
  ),
  CHECK (datetime(updated_at) >= datetime(created_at))
) STRICT;

CREATE TABLE turns (
  turn_id TEXT PRIMARY KEY CHECK (
    length(turn_id) = 36
    AND substr(turn_id, 9, 1) = '-'
    AND substr(turn_id, 14, 1) = '-'
    AND substr(turn_id, 19, 1) = '-'
    AND substr(turn_id, 24, 1) = '-'
    AND length(replace(turn_id, '-', '')) = 32
    AND lower(replace(turn_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
    AND (
      lower(turn_id) IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
      OR (lower(substr(turn_id, 15, 1)) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND lower(substr(turn_id, 20, 1)) IN ('8', '9', 'a', 'b'))
    )
  ),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL CHECK (
    length(client_message_id) = 36
    AND substr(client_message_id, 9, 1) = '-'
    AND substr(client_message_id, 14, 1) = '-'
    AND substr(client_message_id, 19, 1) = '-'
    AND substr(client_message_id, 24, 1) = '-'
    AND length(replace(client_message_id, '-', '')) = 32
    AND lower(replace(client_message_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
    AND (
      lower(client_message_id) IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
      OR (lower(substr(client_message_id, 15, 1)) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND lower(substr(client_message_id, 20, 1)) IN ('8', '9', 'a', 'b'))
    )
  ),
  retry_request_id TEXT CHECK (retry_request_id IS NULL OR (
    length(retry_request_id) = 36
    AND substr(retry_request_id, 9, 1) = '-'
    AND substr(retry_request_id, 14, 1) = '-'
    AND substr(retry_request_id, 19, 1) = '-'
    AND substr(retry_request_id, 24, 1) = '-'
    AND length(replace(retry_request_id, '-', '')) = 32
    AND lower(replace(retry_request_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
    AND (
      lower(retry_request_id) IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
      OR (lower(substr(retry_request_id, 15, 1)) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND lower(substr(retry_request_id, 20, 1)) IN ('8', '9', 'a', 'b'))
    )
  )),
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('answer', 'question', 'quote', 'safe_stop')),
  started_at TEXT NOT NULL CHECK (
    datetime(started_at) IS NOT NULL
    AND started_at GLOB '????-??-??T??:??:??*'
    AND (substr(started_at, -1) = 'Z' OR (substr(started_at, -6, 1) IN ('+', '-') AND substr(started_at, -3, 1) = ':'))
  ),
  completed_at TEXT CHECK (completed_at IS NULL OR (
    datetime(completed_at) IS NOT NULL
    AND completed_at GLOB '????-??-??T??:??:??*'
    AND (substr(completed_at, -1) = 'Z' OR (substr(completed_at, -6, 1) IN ('+', '-') AND substr(completed_at, -3, 1) = ':'))
  )),
  failure_code TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array'),
  UNIQUE (conversation_id, client_message_id),
  UNIQUE (conversation_id, retry_request_id),
  UNIQUE (turn_id, conversation_id),
  CHECK ((status = 'PROCESSING' AND completed_at IS NULL) OR (status <> 'PROCESSING' AND completed_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR datetime(completed_at) >= datetime(started_at))
) STRICT;

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY CHECK (
    length(message_id) = 36
    AND substr(message_id, 9, 1) = '-'
    AND substr(message_id, 14, 1) = '-'
    AND substr(message_id, 19, 1) = '-'
    AND substr(message_id, 24, 1) = '-'
    AND length(replace(message_id, '-', '')) = 32
    AND lower(replace(message_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
    AND (
      lower(message_id) IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
      OR (lower(substr(message_id, 15, 1)) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND lower(substr(message_id, 20, 1)) IN ('8', '9', 'a', 'b'))
    )
  ),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  cited_evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cited_evidence_ids_json) AND json_type(cited_evidence_ids_json) = 'array'),
  created_at TEXT NOT NULL CHECK (
    datetime(created_at) IS NOT NULL
    AND created_at GLOB '????-??-??T??:??:??*'
    AND (substr(created_at, -1) = 'Z' OR (substr(created_at, -6, 1) IN ('+', '-') AND substr(created_at, -3, 1) = ':'))
  ),
  UNIQUE (conversation_id, sequence),
  FOREIGN KEY (turn_id, conversation_id) REFERENCES turns(turn_id, conversation_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE memory_summaries (
  summary_id TEXT PRIMARY KEY CHECK (
    length(summary_id) = 36
    AND substr(summary_id, 9, 1) = '-'
    AND substr(summary_id, 14, 1) = '-'
    AND substr(summary_id, 19, 1) = '-'
    AND substr(summary_id, 24, 1) = '-'
    AND length(replace(summary_id, '-', '')) = 32
    AND lower(replace(summary_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
    AND (
      lower(summary_id) IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
      OR (lower(substr(summary_id, 15, 1)) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND lower(substr(summary_id, 20, 1)) IN ('8', '9', 'a', 'b'))
    )
  ),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  summary_text TEXT NOT NULL CHECK (length(summary_text) BETWEEN 1 AND 8000),
  covers_sequence_from INTEGER NOT NULL CHECK (covers_sequence_from > 0),
  covers_sequence_to INTEGER NOT NULL CHECK (covers_sequence_to >= covers_sequence_from),
  source_message_ids_json TEXT NOT NULL CHECK (json_valid(source_message_ids_json) AND json_type(source_message_ids_json) = 'array'),
  created_at TEXT NOT NULL CHECK (
    datetime(created_at) IS NOT NULL
    AND created_at GLOB '????-??-??T??:??:??*'
    AND (substr(created_at, -1) = 'Z' OR (substr(created_at, -6, 1) IN ('+', '-') AND substr(created_at, -3, 1) = ':'))
  ),
  UNIQUE (conversation_id, version)
) STRICT;

CREATE TABLE customer_facts (
  fact_id TEXT PRIMARY KEY CHECK (
    length(fact_id) = 36
    AND substr(fact_id, 9, 1) = '-'
    AND substr(fact_id, 14, 1) = '-'
    AND substr(fact_id, 19, 1) = '-'
    AND substr(fact_id, 24, 1) = '-'
    AND length(replace(fact_id, '-', '')) = 32
    AND lower(replace(fact_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
    AND (
      lower(fact_id) IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
      OR (lower(substr(fact_id, 15, 1)) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND lower(substr(fact_id, 20, 1)) IN ('8', '9', 'a', 'b'))
    )
  ),
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
  updated_at TEXT NOT NULL CHECK (
    datetime(updated_at) IS NOT NULL
    AND updated_at GLOB '????-??-??T??:??:??*'
    AND (substr(updated_at, -1) = 'Z' OR (substr(updated_at, -6, 1) IN ('+', '-') AND substr(updated_at, -3, 1) = ':'))
  )
) STRICT;

CREATE TABLE knowledge_evidence (
  evidence_id TEXT PRIMARY KEY CHECK (
    length(evidence_id) = 36
    AND substr(evidence_id, 9, 1) = '-'
    AND substr(evidence_id, 14, 1) = '-'
    AND substr(evidence_id, 19, 1) = '-'
    AND substr(evidence_id, 24, 1) = '-'
    AND length(replace(evidence_id, '-', '')) = 32
    AND lower(replace(evidence_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
    AND (
      lower(evidence_id) IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
      OR (lower(substr(evidence_id, 15, 1)) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND lower(substr(evidence_id, 20, 1)) IN ('8', '9', 'a', 'b'))
    )
  ),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
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
  created_at TEXT NOT NULL CHECK (
    datetime(created_at) IS NOT NULL
    AND created_at GLOB '????-??-??T??:??:??*'
    AND (substr(created_at, -1) = 'Z' OR (substr(created_at, -6, 1) IN ('+', '-') AND substr(created_at, -3, 1) = ':'))
  ),
  UNIQUE (turn_id, knowledge_base_id, document_id, document_version, chunk_id),
  UNIQUE (evidence_id, conversation_id),
  FOREIGN KEY (turn_id, conversation_id) REFERENCES turns(turn_id, conversation_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE rule_versions (
  rule_version_id TEXT PRIMARY KEY CHECK (
    length(rule_version_id) = 36
    AND substr(rule_version_id, 9, 1) = '-'
    AND substr(rule_version_id, 14, 1) = '-'
    AND substr(rule_version_id, 19, 1) = '-'
    AND substr(rule_version_id, 24, 1) = '-'
    AND length(replace(rule_version_id, '-', '')) = 32
    AND lower(replace(rule_version_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
    AND (
      lower(rule_version_id) IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
      OR (lower(substr(rule_version_id, 15, 1)) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND lower(substr(rule_version_id, 20, 1)) IN ('8', '9', 'a', 'b'))
    )
  ),
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
  effective_from TEXT NOT NULL CHECK (
    datetime(effective_from) IS NOT NULL
    AND effective_from GLOB '????-??-??T??:??:??*'
    AND (substr(effective_from, -1) = 'Z' OR (substr(effective_from, -6, 1) IN ('+', '-') AND substr(effective_from, -3, 1) = ':'))
  ),
  effective_to TEXT CHECK (effective_to IS NULL OR (
    datetime(effective_to) IS NOT NULL
    AND effective_to GLOB '????-??-??T??:??:??*'
    AND (substr(effective_to, -1) = 'Z' OR (substr(effective_to, -6, 1) IN ('+', '-') AND substr(effective_to, -3, 1) = ':'))
  )),
  source_document TEXT NOT NULL CHECK (length(source_document) BETWEEN 1 AND 500),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 100),
  fixture_owner TEXT NOT NULL CHECK (length(fixture_owner) BETWEEN 1 AND 100),
  fixture_reviewer TEXT NOT NULL CHECK (length(fixture_reviewer) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL CHECK (
    datetime(created_at) IS NOT NULL
    AND created_at GLOB '????-??-??T??:??:??*'
    AND (substr(created_at, -1) = 'Z' OR (substr(created_at, -6, 1) IN ('+', '-') AND substr(created_at, -3, 1) = ':'))
  ),
  validated_at TEXT CHECK (validated_at IS NULL OR (
    datetime(validated_at) IS NOT NULL
    AND validated_at GLOB '????-??-??T??:??:??*'
    AND (substr(validated_at, -1) = 'Z' OR (substr(validated_at, -6, 1) IN ('+', '-') AND substr(validated_at, -3, 1) = ':'))
  )),
  activated_at TEXT CHECK (activated_at IS NULL OR (
    datetime(activated_at) IS NOT NULL
    AND activated_at GLOB '????-??-??T??:??:??*'
    AND (substr(activated_at, -1) = 'Z' OR (substr(activated_at, -6, 1) IN ('+', '-') AND substr(activated_at, -3, 1) = ':'))
  )),
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
  quote_id TEXT PRIMARY KEY CHECK (
    length(quote_id) = 36
    AND substr(quote_id, 9, 1) = '-'
    AND substr(quote_id, 14, 1) = '-'
    AND substr(quote_id, 19, 1) = '-'
    AND substr(quote_id, 24, 1) = '-'
    AND length(replace(quote_id, '-', '')) = 32
    AND lower(replace(quote_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
    AND (
      lower(quote_id) IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
      OR (lower(substr(quote_id, 15, 1)) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND lower(substr(quote_id, 20, 1)) IN ('8', '9', 'a', 'b'))
    )
  ),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  quote_version INTEGER NOT NULL CHECK (quote_version > 0),
  parent_quote_id TEXT CHECK (parent_quote_id IS NULL OR (
    length(parent_quote_id) = 36
    AND substr(parent_quote_id, 9, 1) = '-'
    AND substr(parent_quote_id, 14, 1) = '-'
    AND substr(parent_quote_id, 19, 1) = '-'
    AND substr(parent_quote_id, 24, 1) = '-'
    AND length(replace(parent_quote_id, '-', '')) = 32
    AND lower(replace(parent_quote_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
    AND (
      lower(parent_quote_id) IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
      OR (lower(substr(parent_quote_id, 15, 1)) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND lower(substr(parent_quote_id, 20, 1)) IN ('8', '9', 'a', 'b'))
    )
  )),
  status TEXT NOT NULL DEFAULT 'estimated' CHECK (status = 'estimated'),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json) AND json_type(parameters_json) = 'object'),
  estimated_total_fen INTEGER NOT NULL CHECK (estimated_total_fen BETWEEN 0 AND 9007199254740991),
  assumptions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(assumptions_json) AND json_type(assumptions_json) = 'array'),
  exclusions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exclusions_json) AND json_type(exclusions_json) = 'array'),
  disclaimer TEXT NOT NULL CHECK (length(disclaimer) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL CHECK (
    datetime(created_at) IS NOT NULL
    AND created_at GLOB '????-??-??T??:??:??*'
    AND (substr(created_at, -1) = 'Z' OR (substr(created_at, -6, 1) IN ('+', '-') AND substr(created_at, -3, 1) = ':'))
  ),
  UNIQUE (conversation_id, quote_version),
  UNIQUE (turn_id),
  UNIQUE (quote_id, conversation_id),
  CHECK (parent_quote_id IS NULL OR parent_quote_id <> quote_id),
  FOREIGN KEY (turn_id, conversation_id) REFERENCES turns(turn_id, conversation_id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_quote_id, conversation_id) REFERENCES quote_versions(quote_id, conversation_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE quote_items (
  quote_item_id TEXT PRIMARY KEY CHECK (
    length(quote_item_id) = 36
    AND substr(quote_item_id, 9, 1) = '-'
    AND substr(quote_item_id, 14, 1) = '-'
    AND substr(quote_item_id, 19, 1) = '-'
    AND substr(quote_item_id, 24, 1) = '-'
    AND length(replace(quote_item_id, '-', '')) = 32
    AND lower(replace(quote_item_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
    AND (
      lower(quote_item_id) IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
      OR (lower(substr(quote_item_id, 15, 1)) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND lower(substr(quote_item_id, 20, 1)) IN ('8', '9', 'a', 'b'))
    )
  ),
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
  created_at TEXT NOT NULL CHECK (
    datetime(created_at) IS NOT NULL
    AND created_at GLOB '????-??-??T??:??:??*'
    AND (substr(created_at, -1) = 'Z' OR (substr(created_at, -6, 1) IN ('+', '-') AND substr(created_at, -3, 1) = ':'))
  ),
  UNIQUE (quote_id, position)
) STRICT;

CREATE TABLE quote_knowledge_evidence (
  quote_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  PRIMARY KEY (quote_id, evidence_id),
  FOREIGN KEY (quote_id, conversation_id) REFERENCES quote_versions(quote_id, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id, conversation_id) REFERENCES knowledge_evidence(evidence_id, conversation_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE seed_history (
  seed_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  applied_at TEXT NOT NULL CHECK (
    datetime(applied_at) IS NOT NULL
    AND applied_at GLOB '????-??-??T??:??:??*'
    AND (substr(applied_at, -1) = 'Z' OR (substr(applied_at, -6, 1) IN ('+', '-') AND substr(applied_at, -3, 1) = ':'))
  )
) STRICT;

CREATE INDEX ix_turns_conversation_started ON turns(conversation_id, started_at);
CREATE INDEX ix_messages_conversation_created ON messages(conversation_id, created_at);
CREATE INDEX ix_customer_facts_conversation_key ON customer_facts(conversation_id, fact_key, updated_at);
CREATE INDEX ix_evidence_turn_score ON knowledge_evidence(turn_id, score DESC);
CREATE INDEX ix_rules_lookup ON rule_versions(rule_id, status, city, effective_from, effective_to);
CREATE INDEX ix_quotes_conversation_created ON quote_versions(conversation_id, created_at);
CREATE INDEX ix_quote_items_rule_version ON quote_items(rule_version_id);
