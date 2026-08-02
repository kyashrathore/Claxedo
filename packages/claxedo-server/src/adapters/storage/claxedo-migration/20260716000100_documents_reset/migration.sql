DROP TABLE IF EXISTS `claxedo_page_arena_delivery`;
--> statement-breakpoint
DROP TABLE IF EXISTS `claxedo_page_arena_message`;
--> statement-breakpoint
DROP TABLE IF EXISTS `claxedo_page_arena_wave`;
--> statement-breakpoint
DROP TABLE IF EXISTS `claxedo_page_arena_agent`;
--> statement-breakpoint
DROP TABLE IF EXISTS `claxedo_page_arena`;
--> statement-breakpoint
DROP TABLE IF EXISTS `claxedo_page`;
--> statement-breakpoint
DROP TABLE IF EXISTS `claxedo_document_revision`;
--> statement-breakpoint
DROP TABLE IF EXISTS `claxedo_document`;
--> statement-breakpoint
CREATE TABLE `claxedo_document_index` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `project_id` text NOT NULL,
  `display_name` text NOT NULL,
  `origin_kind` text NOT NULL,
  `placement_kind` text NOT NULL,
  `placement_id` text NOT NULL,
  `managed_relative_path` text,
  `repository_id` text,
  `workspace_id` text,
  `repository_relative_path` text,
  `branch` text,
  `status` text DEFAULT 'draft' NOT NULL,
  `session_id` text,
  `archived_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `last_opened_at` text,
  `last_known_file_version` text,
  CONSTRAINT `claxedo_document_index_origin_check` CHECK (
    (`origin_kind` = 'managed'
      AND `managed_relative_path` IS NOT NULL
      AND length(`managed_relative_path`) > 0
      AND `repository_id` IS NULL
      AND `workspace_id` IS NULL
      AND `repository_relative_path` IS NULL
      AND `branch` IS NULL)
    OR
    (`origin_kind` = 'repository'
      AND `managed_relative_path` IS NULL
      AND `repository_id` IS NOT NULL
      AND length(`repository_id`) > 0
      AND `workspace_id` IS NOT NULL
      AND length(`workspace_id`) > 0
      AND `repository_relative_path` IS NOT NULL
      AND length(`repository_relative_path`) > 0
      AND (`branch` IS NULL OR length(`branch`) > 0))
  ),
  CONSTRAINT `claxedo_document_index_placement_check` CHECK (`placement_kind` IN ('local', 'hosted')),
  CONSTRAINT `claxedo_document_index_common_nonempty_check` CHECK (
    length(`id`) > 0
    AND length(`org_id`) > 0
    AND length(`project_id`) > 0
    AND length(`display_name`) > 0
    AND length(`placement_id`) > 0
    AND length(`status`) > 0
    AND length(`created_at`) > 0
    AND length(`updated_at`) > 0
  ),
  CONSTRAINT `claxedo_document_index_optional_nonempty_check` CHECK (
    (`session_id` IS NULL OR length(`session_id`) > 0)
    AND (`archived_at` IS NULL OR length(`archived_at`) > 0)
    AND (`last_opened_at` IS NULL OR length(`last_opened_at`) > 0)
    AND (`last_known_file_version` IS NULL OR length(`last_known_file_version`) > 0)
  )
);
--> statement-breakpoint
CREATE INDEX `claxedo_document_index_project_idx`
  ON `claxedo_document_index` (`org_id`, `project_id`, `archived_at`, `updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `claxedo_document_index_managed_path_unique`
  ON `claxedo_document_index` (`org_id`, `project_id`, `managed_relative_path`);
--> statement-breakpoint
CREATE UNIQUE INDEX `claxedo_document_index_repository_path_unique`
  ON `claxedo_document_index` (`org_id`, `project_id`, `repository_id`, `repository_relative_path`);
--> statement-breakpoint
CREATE TABLE `claxedo_local_project` (
  `directory` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claxedo_local_project_id_unique` ON `claxedo_local_project` (`project_id`);
