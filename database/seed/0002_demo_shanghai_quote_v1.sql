-- Cloud-test-only fictional C06 v1 local quotation rules.
-- Source database conversations, turns and API credentials are intentionally
-- not exported with this seed.
INSERT INTO rule_versions (
  rule_version_id, rule_id, version, status, city, calculation_type,
  amount_fen, unit_price_fen, coefficient, base_rule_id, minimum_price_fen,
  conditions_json, conflict_group, effective_from, effective_to,
  source_document, source_version, fixture_owner, fixture_reviewer,
  created_at, validated_at, activated_at
) VALUES
  (
    '20000000-0000-4000-8000-000000000001', 'DEMO-SH-DESIGN-AREA-001', 1, 'active',
    '上海', 'AREA_MULTIPLY', NULL, 12000, NULL, NULL, NULL,
    '{"service_scope":"whole_home","material_tier":"demo_standard","designer_tier":"demo_standard"}',
    NULL, '2026-08-01T00:00:00Z', NULL,
    'demo-shanghai-public-rule-index-v1.xlsx', '1.0.0-demo',
    'DEMO-ONLY-业务负责人', 'DEMO-ONLY-报价审批人',
    '2026-08-07T00:00:00Z', '2026-08-07T00:00:00Z', '2026-08-07T00:00:00Z'
  ),
  (
    '20000000-0000-4000-8000-000000000002', 'DEMO-SH-MATERIAL-AREA-001', 1, 'active',
    '上海', 'AREA_MULTIPLY', NULL, 88000, NULL, NULL, NULL,
    '{"service_scope":"whole_home","material_tier":"demo_standard"}',
    NULL, '2026-08-01T00:00:00Z', NULL,
    'demo-shanghai-public-rule-index-v1.xlsx', '1.0.0-demo',
    'DEMO-ONLY-业务负责人', 'DEMO-ONLY-报价审批人',
    '2026-08-07T00:00:00Z', '2026-08-07T00:00:00Z', '2026-08-07T00:00:00Z'
  ),
  (
    '20000000-0000-4000-8000-000000000003', 'DEMO-SH-OLDHOME-SURCHARGE-001', 1, 'active',
    '上海', 'CONDITIONAL_SURCHARGE', 600000, NULL, NULL, NULL, NULL,
    '{"service_scope":"whole_home","house_state":"old_renovation"}',
    NULL, '2026-08-01T00:00:00Z', NULL,
    'demo-shanghai-public-rule-index-v1.xlsx', '1.0.0-demo',
    'DEMO-ONLY-业务负责人', 'DEMO-ONLY-报价审批人',
    '2026-08-07T00:00:00Z', '2026-08-07T00:00:00Z', '2026-08-07T00:00:00Z'
  );
