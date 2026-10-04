CREATE TABLE IF NOT EXISTS `claxedo_channel_run_audit` (
  `session_id` text PRIMARY KEY NOT NULL,
  `channel` text NOT NULL,
  `external_user_id` text NOT NULL,
  `thread_key` text NOT NULL,
  `workspace_id` text,
  `cost` real,
  `created_at` integer NOT NULL
);

CREATE INDEX IF NOT EXISTS `claxedo_channel_run_audit_channel_created_idx`
  ON `claxedo_channel_run_audit` (`channel`, `created_at`);

CREATE INDEX IF NOT EXISTS `claxedo_channel_run_audit_user_created_idx`
  ON `claxedo_channel_run_audit` (`channel`, `external_user_id`, `created_at`);

CREATE INDEX IF NOT EXISTS `claxedo_channel_run_audit_workspace_created_idx`
  ON `claxedo_channel_run_audit` (`workspace_id`, `created_at`);
