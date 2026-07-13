-- ProviderModel.enabledFlags is persisted inside models_json. Rebuild Codex
-- catalog rows so the new provider default is effective immediately after
-- deployment instead of waiting for the 24-hour stale cache window to expire.
DELETE FROM models_cache
WHERE upstream_id IN (
  SELECT id
  FROM upstreams
  WHERE provider = 'codex'
);
