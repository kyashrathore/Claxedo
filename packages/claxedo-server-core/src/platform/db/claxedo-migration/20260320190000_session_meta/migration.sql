CREATE TABLE IF NOT EXISTS `claxedo_session_meta` (
  `session_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text,
  `project_id` text,
  `directory` text NOT NULL,
  `title` text,
  `parent_session_id` text,
  `archived_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_workspace_idx`
ON `claxedo_session_meta` (`workspace_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_project_idx`
ON `claxedo_session_meta` (`project_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_parent_idx`
ON `claxedo_session_meta` (`parent_session_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_updated_idx`
ON `claxedo_session_meta` (`updated_at`);

CREATE TABLE IF NOT EXISTS `claxedo_session_attachment` (
  `session_id` text NOT NULL,
  `kind` text NOT NULL,
  `target_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`session_id`, `kind`, `target_id`)
);

CREATE INDEX IF NOT EXISTS `claxedo_session_attachment_kind_idx`
ON `claxedo_session_attachment` (`kind`, `target_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_attachment_session_idx`
ON `claxedo_session_attachment` (`session_id`);

CREATE TABLE IF NOT EXISTS `claxedo_session_tag` (
  `session_id` text NOT NULL,
  `tag` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`session_id`, `tag`)
);

CREATE INDEX IF NOT EXISTS `claxedo_session_tag_session_idx`
ON `claxedo_session_tag` (`session_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_tag_tag_idx`
ON `claxedo_session_tag` (`tag`);
