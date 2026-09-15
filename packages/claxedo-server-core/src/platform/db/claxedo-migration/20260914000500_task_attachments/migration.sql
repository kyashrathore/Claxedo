-- Images attached to a task at create, one per row with the bytes inline.
CREATE TABLE IF NOT EXISTS `claxedo_task_attachment` (
	`scope_id` text NOT NULL,
	`task_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`position` integer NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`bytes` blob NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `task_id`, `attachment_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `claxedo_task_attachment_task_idx` ON `claxedo_task_attachment` (`scope_id`,`task_id`,`position`);
