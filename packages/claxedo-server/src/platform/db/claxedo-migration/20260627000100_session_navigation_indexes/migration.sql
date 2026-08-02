CREATE INDEX IF NOT EXISTS `claxedo_session_meta_workspace_archive_updated_idx`
ON `claxedo_session_meta` (`workspace_id`, `archived_at`, `updated_at`, `session_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_directory_archive_updated_idx`
ON `claxedo_session_meta` (`directory`, `archived_at`, `updated_at`, `session_id`);

CREATE INDEX IF NOT EXISTS `claxedo_session_meta_project_archive_updated_idx`
ON `claxedo_session_meta` (`project_id`, `archived_at`, `updated_at`, `session_id`);
