DROP TABLE IF EXISTS `claxedo_page`;--> statement-breakpoint
CREATE TABLE `claxedo_page` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `project_id` text NOT NULL,
  `title` text NOT NULL DEFAULT 'Untitled',
  `content` text NOT NULL DEFAULT '',
  `visibility` text NOT NULL DEFAULT 'project',
  `version` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL DEFAULT 'draft',
  `session_id` text,
  `directory` text,
  `source_kind` text,
  `source_repo_root` text,
  `source_repo_key` text,
  `source_path` text,
  `source_branch` text,
  `base_commit` text,
  `base_blob_sha` text,
  `base_tree_sha` text,
  `last_materialized_commit` text,
  `last_materialized_blob_sha` text,
  `last_commit_at` text,
  `last_commit_author_id` text,
  `commit_status` text NOT NULL DEFAULT 'draft',
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `claxedo_page_project_idx` ON `claxedo_page` (`org_id`, `project_id`);--> statement-breakpoint
CREATE INDEX `claxedo_page_updated_idx` ON `claxedo_page` (`org_id`, `project_id`, `updated_at`);
