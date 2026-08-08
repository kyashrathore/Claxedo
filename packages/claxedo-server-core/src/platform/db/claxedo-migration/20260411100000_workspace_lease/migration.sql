-- Durable workspace lease: one row per workspace, owns live truth
CREATE TABLE `claxedo_workspace_lease` (
  `workspace_id` text PRIMARY KEY NOT NULL,
  `lease_id` text NOT NULL,
  `epoch` integer NOT NULL DEFAULT 1,
  `status` text NOT NULL DEFAULT 'pending',
  `provider` text NOT NULL,
  `provider_object_id` text,
  `provider_snapshot_id` text,
  `sandbox_id` text,
  `runtime_url` text,
  `retry_count` integer NOT NULL DEFAULT 0,
  `next_retry_at` integer,
  `last_heartbeat_at` integer,
  `last_activity_at` integer,
  `last_health_failure_at` integer,
  `last_error` text,
  `compute_class` text,
  `accel_base_image_id` text,
  `accel_prepared_image_id` text,
  `accel_runtime_snapshot_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claxedo_workspace_lease_status_idx` ON `claxedo_workspace_lease` (`status`);
--> statement-breakpoint
CREATE INDEX `claxedo_workspace_lease_sandbox_idx` ON `claxedo_workspace_lease` (`sandbox_id`);
--> statement-breakpoint
CREATE INDEX `claxedo_workspace_lease_updated_idx` ON `claxedo_workspace_lease` (`updated_at`);
--> statement-breakpoint

-- Explicit holds: one row per active hold, prevents premature idle stop
CREATE TABLE `claxedo_workspace_hold` (
  `hold_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `owner_type` text NOT NULL,
  `owner_id` text NOT NULL,
  `reason` text NOT NULL,
  `expires_at` integer,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claxedo_workspace_hold_workspace_idx` ON `claxedo_workspace_hold` (`workspace_id`);
--> statement-breakpoint
CREATE INDEX `claxedo_workspace_hold_expires_idx` ON `claxedo_workspace_hold` (`expires_at`);
