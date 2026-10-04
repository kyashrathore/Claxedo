ALTER TABLE `claxedo_session_meta` ADD COLUMN `last_turn_status` text;
--> statement-breakpoint
ALTER TABLE `claxedo_session_meta` ADD COLUMN `last_turn_completed_at` integer;
