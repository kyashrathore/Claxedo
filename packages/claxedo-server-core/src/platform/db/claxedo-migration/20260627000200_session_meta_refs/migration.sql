ALTER TABLE `claxedo_session_meta` RENAME TO `claxedo_session_meta_old_refs`;

CREATE TABLE `claxedo_session_meta` (
  `session_ref` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `workspace_id` text,
  `project_id` text,
  `host` text NOT NULL DEFAULT 'workspace',
  `directory` text,
  `title` text,
  `parent_session_id` text,
  `archived_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);

INSERT OR REPLACE INTO `claxedo_session_meta` (
  `session_ref`,
  `session_id`,
  `workspace_id`,
  `project_id`,
  `host`,
  `directory`,
  `title`,
  `parent_session_id`,
  `archived_at`,
  `created_at`,
  `updated_at`
)
SELECT
  CASE
    WHEN `workspace_id` IS NOT NULL AND `workspace_id` <> '' THEN 'workspace:' || `workspace_id` || ':session:' || `session_id`
    WHEN `host` = 'central' THEN 'central:' || `session_id`
    ELSE 'local:' || COALESCE(NULLIF(`directory`, ''), 'global') || ':session:' || `session_id`
  END,
  `session_id`,
  `workspace_id`,
  `project_id`,
  COALESCE(NULLIF(`host`, ''), 'workspace'),
  NULLIF(`directory`, ''),
  `title`,
  `parent_session_id`,
  `archived_at`,
  `created_at`,
  `updated_at`
FROM `claxedo_session_meta_old_refs`;

ALTER TABLE `claxedo_session_attachment` RENAME TO `claxedo_session_attachment_old_refs`;

CREATE TABLE `claxedo_session_attachment` (
  `session_ref` text NOT NULL,
  `session_id` text NOT NULL,
  `kind` text NOT NULL,
  `target_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`session_ref`, `kind`, `target_id`)
);

INSERT OR REPLACE INTO `claxedo_session_attachment` (
  `session_ref`,
  `session_id`,
  `kind`,
  `target_id`,
  `created_at`,
  `updated_at`
)
SELECT
  m.`session_ref`,
  a.`session_id`,
  a.`kind`,
  a.`target_id`,
  a.`created_at`,
  a.`updated_at`
FROM `claxedo_session_attachment_old_refs` a
JOIN `claxedo_session_meta` m ON m.`session_id` = a.`session_id`;

ALTER TABLE `claxedo_session_tag` RENAME TO `claxedo_session_tag_old_refs`;

CREATE TABLE `claxedo_session_tag` (
  `session_ref` text NOT NULL,
  `session_id` text NOT NULL,
  `tag` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`session_ref`, `tag`)
);

INSERT OR REPLACE INTO `claxedo_session_tag` (
  `session_ref`,
  `session_id`,
  `tag`,
  `created_at`,
  `updated_at`
)
SELECT
  m.`session_ref`,
  t.`session_id`,
  t.`tag`,
  t.`created_at`,
  t.`updated_at`
FROM `claxedo_session_tag_old_refs` t
JOIN `claxedo_session_meta` m ON m.`session_id` = t.`session_id`;

DROP TABLE `claxedo_session_meta_old_refs`;
DROP TABLE `claxedo_session_attachment_old_refs`;
DROP TABLE `claxedo_session_tag_old_refs`;

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_workspace_idx`
ON `claxedo_session_meta` (`workspace_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_session_idx`
ON `claxedo_session_meta` (`session_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_project_idx`
ON `claxedo_session_meta` (`project_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_parent_idx`
ON `claxedo_session_meta` (`parent_session_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_updated_idx`
ON `claxedo_session_meta` (`updated_at`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_workspace_archive_updated_idx`
ON `claxedo_session_meta` (`workspace_id`, `archived_at`, `updated_at`, `session_ref`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_directory_archive_updated_idx`
ON `claxedo_session_meta` (`directory`, `archived_at`, `updated_at`, `session_ref`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_project_archive_updated_idx`
ON `claxedo_session_meta` (`project_id`, `archived_at`, `updated_at`, `session_ref`);

CREATE INDEX IF NOT EXISTS `claxedo_session_attachment_kind_idx`
ON `claxedo_session_attachment` (`kind`, `target_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_attachment_ref_idx`
ON `claxedo_session_attachment` (`session_ref`);

CREATE INDEX IF NOT EXISTS `claxedo_session_attachment_session_idx`
ON `claxedo_session_attachment` (`session_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_tag_ref_idx`
ON `claxedo_session_tag` (`session_ref`);

CREATE INDEX IF NOT EXISTS `claxedo_session_tag_session_idx`
ON `claxedo_session_tag` (`session_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_tag_tag_idx`
ON `claxedo_session_tag` (`tag`);
