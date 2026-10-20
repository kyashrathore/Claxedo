-- Which session's agent started a linked attempt, and where it runs. Every
-- link that exists was started by a person from the app, in the task's own
-- workspace, so the backfill is null and local.
ALTER TABLE `claxedo_task_session_link` ADD `started_from_session_id` text;
--> statement-breakpoint
ALTER TABLE `claxedo_task_session_link` ADD `started_from_workspace_id` text;
--> statement-breakpoint
ALTER TABLE `claxedo_task_session_link` ADD `placement` text DEFAULT 'local' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `claxedo_task_session_link_session_idx` ON `claxedo_task_session_link` (`scope_id`,`session_id`);
