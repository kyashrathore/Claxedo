ALTER TABLE `claxedo_usage_turn_revision` ADD COLUMN `native_session_id` text;
--> statement-breakpoint
ALTER TABLE `claxedo_usage_turn_current` ADD COLUMN `native_session_id` text;
--> statement-breakpoint
CREATE TABLE `claxedo_usage_source_coverage` (
  `source` text PRIMARY KEY NOT NULL,
  `started_at` integer NOT NULL
);
