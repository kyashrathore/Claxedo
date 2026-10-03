CREATE INDEX `claxedo_session_meta_archive_human_turn_idx` ON `claxedo_session_meta` (`archived_at`, `last_human_turn_at`, `created_at`, `session_ref`);
