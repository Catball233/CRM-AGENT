INSERT INTO conversations (
  conversation_id, contract_version, stage, status, created_at, updated_at
) VALUES (
  '10000000-0000-4000-8000-000000000001', '1.0.0', 'QUOTING', 'ACTIVE',
  '2026-08-05T08:00:00Z', '2026-08-05T08:00:05Z'
);

INSERT INTO turns (
  turn_id, conversation_id, client_message_id, status, outcome, started_at, completed_at
) VALUES (
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000003',
  'COMPLETED', 'quote', '2026-08-05T08:00:00Z', '2026-08-05T08:00:05Z'
);

INSERT INTO messages (
  message_id, conversation_id, turn_id, role, content, sequence, cited_evidence_ids_json, created_at
) VALUES
  (
    '10000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'user', '这是用于本地测试的虚构装修询价。', 1, '[]', '2026-08-05T08:00:00Z'
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'assistant', '已按虚构测试规则生成预估报价。', 2,
    '["10000000-0000-4000-8000-000000000007"]', '2026-08-05T08:00:05Z'
  );

INSERT INTO customer_facts (
  fact_id, conversation_id, fact_key, category, value_json, status, confidence, source_refs_json, updated_at
) VALUES (
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000001',
  'city', 'requirement', '"示例市"', 'confirmed', 1.0,
  '[{"source_type":"message","source_id":"10000000-0000-4000-8000-000000000003"}]',
  '2026-08-05T08:00:01Z'
);

INSERT INTO memory_summaries (
  summary_id, conversation_id, version, summary_text, covers_sequence_from,
  covers_sequence_to, source_message_ids_json, created_at
) VALUES (
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000001', 1,
  '虚构测试客户咨询示例市的整屋装修。', 1, 1,
  '["10000000-0000-4000-8000-000000000003"]', '2026-08-05T08:00:02Z'
);

INSERT INTO knowledge_evidence (
  evidence_id, conversation_id, turn_id, contract_version, knowledge_base_id,
  document_id, document_version, chunk_id, title, excerpt, score, metadata_json,
  candidate_rule_ids_json, provider_request_id, created_at
) VALUES (
  '10000000-0000-4000-8000-000000000007',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002', '1.0.0',
  'kb-fixture-local', 'doc-fixture-pricing', 'fixture-1.0.0', 'chunk-fixture-001',
  '虚构报价规则样例', '仅用于自动化测试：示例市基础设计服务按面积计价。', 0.95,
  '{"category":"pricing","city":"示例市","effective_from":"2026-08-05T00:00:00Z"}',
  '["FIXTURE-DESIGN-AREA-001"]', 'fixture-request-001', '2026-08-05T08:00:03Z'
);

INSERT INTO rule_versions (
  rule_version_id, rule_id, version, status, city, calculation_type, unit_price_fen,
  conditions_json, effective_from, source_document, source_version, fixture_owner,
  fixture_reviewer, created_at, validated_at, activated_at
) VALUES (
  '10000000-0000-4000-8000-000000000008', 'FIXTURE-DESIGN-AREA-001', 1, 'active',
  '示例市', 'AREA_MULTIPLY', 10000,
  '{"service_scope":"whole_home","material_tier":"fixture_standard"}',
  '2026-08-05T00:00:00Z', 'fixture://quote-rules/design-area', 'fixture-1.0.0',
  'role-c-fixture', 'role-a-fixture', '2026-08-05T07:50:00Z',
  '2026-08-05T07:51:00Z', '2026-08-05T07:52:00Z'
);

INSERT INTO quote_versions (
  quote_id, conversation_id, turn_id, quote_version, status, currency, parameters_json,
  estimated_total_fen, assumptions_json, exclusions_json, disclaimer, created_at
) VALUES (
  '10000000-0000-4000-8000-000000000009',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002', 1, 'estimated', 'CNY',
  '{"city":"示例市","area_sqm":80,"house_state":"rough","service_scope":"whole_home","material_tier":"fixture_standard","designer_tier":"fixture_standard","quantities":{},"special_requirements":[]}',
  800000, '["面积按客户自述的80平方米计算"]', '["不包含未列明项目"]',
  '本报价仅为虚构的本地测试数据，不构成真实商业报价。', '2026-08-05T08:00:04Z'
);

INSERT INTO quote_items (
  quote_item_id, quote_id, position, category, label, calculation_type, quantity,
  unit, unit_price_fen, amount_fen, calculation_inputs_json, rule_version_id, created_at
) VALUES (
  '10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000009', 1, 'design', '虚构基础设计费',
  'AREA_MULTIPLY', 80, 'sqm', 10000, 800000, '{"area_sqm":80}',
  '10000000-0000-4000-8000-000000000008', '2026-08-05T08:00:04Z'
);

INSERT INTO quote_knowledge_evidence (quote_id, evidence_id, conversation_id) VALUES (
  '10000000-0000-4000-8000-000000000009',
  '10000000-0000-4000-8000-000000000007',
  '10000000-0000-4000-8000-000000000001'
);
