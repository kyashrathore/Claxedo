CREATE TABLE `claxedo_usage_turn_revision` (
  `host_id` text NOT NULL,
  `session_ref` text NOT NULL,
  `session_id` text NOT NULL,
  `message_id` text NOT NULL,
  `revision` integer NOT NULL,
  `payload_hash` text NOT NULL,
  `observed_at` integer NOT NULL,
  `completed_at` integer,
  `settlement` text NOT NULL,
  `status` text NOT NULL,
  `location` text NOT NULL,
  `harness` text NOT NULL,
  `provider_id` text NOT NULL,
  `model_id` text NOT NULL,
  `workspace_id` text,
  `input_tokens` integer,
  `output_tokens` integer,
  `reasoning_tokens` integer,
  `cache_read_tokens` integer,
  `cache_write_tokens` integer,
  `quality_json` text NOT NULL,
  PRIMARY KEY (`host_id`, `session_ref`, `message_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `claxedo_usage_turn_revision_observed_idx` ON `claxedo_usage_turn_revision` (`observed_at`);
--> statement-breakpoint
CREATE TABLE `claxedo_usage_turn_current` (
  `host_id` text NOT NULL,
  `session_ref` text NOT NULL,
  `session_id` text NOT NULL,
  `message_id` text NOT NULL,
  `revision` integer NOT NULL,
  `payload_hash` text NOT NULL,
  `observed_at` integer NOT NULL,
  `completed_at` integer,
  `settlement` text NOT NULL,
  `status` text NOT NULL,
  `location` text NOT NULL,
  `harness` text NOT NULL,
  `provider_id` text NOT NULL,
  `model_id` text NOT NULL,
  `workspace_id` text,
  `input_tokens` integer,
  `output_tokens` integer,
  `reasoning_tokens` integer,
  `cache_read_tokens` integer,
  `cache_write_tokens` integer,
  `quality_json` text NOT NULL,
  PRIMARY KEY (`host_id`, `session_ref`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `claxedo_usage_turn_current_observed_idx` ON `claxedo_usage_turn_current` (`observed_at`);
--> statement-breakpoint
CREATE INDEX `claxedo_usage_turn_current_workspace_idx` ON `claxedo_usage_turn_current` (`workspace_id`, `observed_at`);
--> statement-breakpoint
CREATE TABLE `claxedo_usage_outbox` (
  `host_id` text NOT NULL,
  `session_ref` text NOT NULL,
  `message_id` text NOT NULL,
  `revision` integer NOT NULL,
  `payload_hash` text NOT NULL,
  `state` text NOT NULL DEFAULT 'pending',
  `attempts` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`host_id`, `session_ref`, `message_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `claxedo_usage_outbox_state_created_idx` ON `claxedo_usage_outbox` (`state`, `created_at`);
