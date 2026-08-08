CREATE TABLE IF NOT EXISTS `claxedo_cloud_session` (
  `session_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `directory` text NOT NULL,
  `title` text,
  `provider` text,
  `data` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer
);

CREATE INDEX IF NOT EXISTS `claxedo_cloud_session_workspace_idx`
ON `claxedo_cloud_session` (`workspace_id`);

CREATE INDEX IF NOT EXISTS `claxedo_cloud_session_updated_idx`
ON `claxedo_cloud_session` (`updated_at`);

CREATE TABLE IF NOT EXISTS `claxedo_cloud_message` (
  `message_id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `role` text,
  `ordinal` integer NOT NULL,
  `data` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);

CREATE INDEX IF NOT EXISTS `claxedo_cloud_message_session_idx`
ON `claxedo_cloud_message` (`session_id`, `ordinal`);

CREATE INDEX IF NOT EXISTS `claxedo_cloud_message_workspace_idx`
ON `claxedo_cloud_message` (`workspace_id`);
