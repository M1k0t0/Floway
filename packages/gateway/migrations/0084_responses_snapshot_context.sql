ALTER TABLE responses_snapshots ADD COLUMN context_item_id TEXT
  CHECK (context_item_id IS NULL OR length(context_item_id) > 0);
