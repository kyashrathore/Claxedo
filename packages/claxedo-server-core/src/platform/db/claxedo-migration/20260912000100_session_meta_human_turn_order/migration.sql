CREATE INDEX IF NOT EXISTS `claxedo_session_meta_workspace_archive_human_turn_idx` ON `claxedo_session_meta` (`workspace_id`,`archived_at`,`last_human_turn_at`,`created_at`,`session_ref`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `claxedo_session_meta_directory_archive_human_turn_idx` ON `claxedo_session_meta` (`directory`,`archived_at`,`last_human_turn_at`,`created_at`,`session_ref`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `claxedo_session_meta_project_archive_human_turn_idx` ON `claxedo_session_meta` (`project_id`,`archived_at`,`last_human_turn_at`,`created_at`,`session_ref`);
