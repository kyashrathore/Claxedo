CREATE TABLE IF NOT EXISTS `claxedo_task_preset` (
	`scope_id` text NOT NULL,
	`preset_id` text NOT NULL,
	`revision` integer NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`instructions` text NOT NULL,
	`execution` text NOT NULL,
	`configurations` text NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`scope_id`, `preset_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `claxedo_task_preset_page_idx` ON `claxedo_task_preset` (`scope_id`,`owner_id`,`created_at`,`preset_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `claxedo_task` (
	`scope_id` text NOT NULL,
	`task_id` text NOT NULL,
	`revision` integer NOT NULL,
	`project_id` text NOT NULL,
	`number` integer NOT NULL,
	`workspace_id` text,
	`parent_task_id` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`child_set_revision` integer NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`scope_id`, `task_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `claxedo_task_project_page_idx` ON `claxedo_task` (`scope_id`,`project_id`,`created_at`,`task_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `claxedo_task_child_page_idx` ON `claxedo_task` (`scope_id`,`parent_task_id`,`created_at`,`task_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `claxedo_task_number_idx` ON `claxedo_task` (`scope_id`,`project_id`,`number`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `claxedo_task_session_link` (
	`scope_id` text NOT NULL,
	`task_id` text NOT NULL,
	`slot` text NOT NULL,
	`attempt` integer NOT NULL,
	`session_id` text NOT NULL,
	`session_workspace_id` text,
	`continued_from_session_id` text,
	`continued_from_workspace_id` text,
	`preset_id` text NOT NULL,
	`preset_revision` integer NOT NULL,
	`preset_name_at_start` text NOT NULL,
	`configuration_digest` text NOT NULL,
	`handoff_text` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`scope_id`, `task_id`, `slot`, `attempt`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `claxedo_task_command_receipt` (
	`scope_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`command_name` text NOT NULL,
	`request_hash` text NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`scope_id`, `client_request_id`)
);
