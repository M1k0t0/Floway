ALTER TABLE responses_snapshots ADD COLUMN source_item_ids_json TEXT
  CHECK (source_item_ids_json IS NULL OR length(source_item_ids_json) > 0);
