ALTER TABLE claxedo_document_index ADD COLUMN creator_id TEXT CHECK (creator_id IS NULL OR length(creator_id) > 0);
