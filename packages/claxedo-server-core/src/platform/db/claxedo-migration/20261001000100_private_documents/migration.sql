ALTER TABLE claxedo_document_index ADD COLUMN creator_id TEXT CHECK (creator_id IS NULL OR length(creator_id) > 0);
--> statement-breakpoint
CREATE TABLE document_shares (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('person', 'team', 'link')),
  target_id TEXT NOT NULL CHECK (length(target_id) > 0),
  level TEXT NOT NULL CHECK (level IN ('view', 'edit')),
  created_by TEXT NOT NULL,
  revoked_at INTEGER,
  CHECK (target <> 'link' OR (level = 'view' AND length(target_id) = 64))
);
--> statement-breakpoint
CREATE INDEX document_shares_document ON document_shares(document_id, revoked_at);
--> statement-breakpoint
CREATE UNIQUE INDEX document_shares_link ON document_shares(target_id) WHERE target = 'link';
