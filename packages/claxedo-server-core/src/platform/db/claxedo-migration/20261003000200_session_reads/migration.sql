CREATE TABLE `claxedo_session_reads` (
	`user_id` text NOT NULL,
	`session_ref` text NOT NULL,
	`seen_at` integer,
	`settled_at` integer,
	PRIMARY KEY(`user_id`, `session_ref`)
);
--> statement-breakpoint
CREATE INDEX `claxedo_session_reads_ref_idx` ON `claxedo_session_reads` (`session_ref`);
