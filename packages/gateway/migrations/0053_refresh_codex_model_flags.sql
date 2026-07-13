-- ProviderModel.enabledFlags is persisted inside models_json. Delete Codex
-- catalog rows so provider defaults are rebuilt instead of serving an omitted
-- flag for the 24-hour stale cache window.
DELETE FROM models_cache
WHERE upstream_id IN (
  SELECT id
  FROM upstreams
  WHERE provider = 'codex'
);
