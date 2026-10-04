ALTER TABLE `claxedo_session_meta` RENAME TO `claxedo_session_meta_old`;

CREATE TABLE `claxedo_session_meta` (
  `session_id` text PRIMARY KEY NOT NULL,
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

INSERT INTO `claxedo_session_meta` (
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
  `session_id`,
  `workspace_id`,
  `project_id`,
  'workspace',
  NULLIF(`directory`, ''),
  `title`,
  `parent_session_id`,
  `archived_at`,
  `created_at`,
  `updated_at`
FROM `claxedo_session_meta_old`;

DROP TABLE `claxedo_session_meta_old`;

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_workspace_idx`
ON `claxedo_session_meta` (`workspace_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_project_idx`
ON `claxedo_session_meta` (`project_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_parent_idx`
ON `claxedo_session_meta` (`parent_session_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_updated_idx`
ON `claxedo_session_meta` (`updated_at`);
