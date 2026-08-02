-- Prepared image registry: tracks workspace-scoped accelerated images
CREATE TABLE `claxedo_prepared_image` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_key` text NOT NULL,
  `base_image_id` text NOT NULL,
  `prepared_image_id` text,
  `source_ref` text,
  `source_sha` text,
  `runtime_fingerprint` text,
  `profile_hash` text,
  `status` text NOT NULL DEFAULT 'pending',
  `build_error` text,
  `build_duration_ms` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claxedo_prepared_image_workspace_key_idx` ON `claxedo_prepared_image` (`workspace_key`);
--> statement-breakpoint
CREATE INDEX `claxedo_prepared_image_status_idx` ON `claxedo_prepared_image` (`status`);
--> statement-breakpoint
CREATE INDEX `claxedo_prepared_image_updated_idx` ON `claxedo_prepared_image` (`updated_at`);
--> statement-breakpoint

-- Runtime snapshot registry: per-workspace snapshots for cheap resume
CREATE TABLE `claxedo_runtime_snapshot` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `runtime_snapshot_id` text NOT NULL,
  `provider_snapshot_id` text,
  `base_prepared_image_id` text,
  `source_sha` text,
  `reason` text NOT NULL,
  `size_bytes` integer,
  `status` text NOT NULL DEFAULT 'pending',
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claxedo_runtime_snapshot_workspace_idx` ON `claxedo_runtime_snapshot` (`workspace_id`);
--> statement-breakpoint
CREATE INDEX `claxedo_runtime_snapshot_status_idx` ON `claxedo_runtime_snapshot` (`status`);
