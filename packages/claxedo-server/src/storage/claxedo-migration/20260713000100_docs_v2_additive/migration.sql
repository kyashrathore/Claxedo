CREATE TABLE IF NOT EXISTS `claxedo_document` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `project_id` text NOT NULL,
  `title` text NOT NULL,
  `head_revision_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);

CREATE INDEX IF NOT EXISTS `claxedo_document_project_idx`
  ON `claxedo_document` (`org_id`, `project_id`, `updated_at`);
CREATE UNIQUE INDEX IF NOT EXISTS `claxedo_document_org_id_unique`
  ON `claxedo_document` (`org_id`, `id`);

CREATE TABLE IF NOT EXISTS `claxedo_document_revision` (
  `id` text PRIMARY KEY NOT NULL,
  `document_id` text NOT NULL REFERENCES `claxedo_document`(`id`) ON DELETE CASCADE,
  `revision_number` integer NOT NULL,
  `parent_revision_id` text,
  `title` text NOT NULL,
  `markdown` text NOT NULL,
  `content_hash` text NOT NULL,
  `authored_at` integer NOT NULL,
  `authored_by_type` text NOT NULL,
  `authored_by_id` text NOT NULL,
  `created_at` integer NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS `claxedo_document_revision_number_unique`
  ON `claxedo_document_revision` (`document_id`, `revision_number`);
CREATE INDEX IF NOT EXISTS `claxedo_document_revision_document_idx`
  ON `claxedo_document_revision` (`document_id`, `created_at`);
