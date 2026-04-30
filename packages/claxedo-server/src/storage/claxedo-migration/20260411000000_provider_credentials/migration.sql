-- Provider credentials: metadata only, no raw secret material
CREATE TABLE `claxedo_provider_credential` (
  `id` text PRIMARY KEY NOT NULL,
  `provider_id` text NOT NULL,
  `kind` text NOT NULL,
  `source` text NOT NULL,
  `label` text,
  `account_id` text,
  `secure_ref` text,
  `status` text NOT NULL DEFAULT 'available',
  `expires_at` integer,
  `last_validated_at` integer,
  `last_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claxedo_provider_credential_provider_idx` ON `claxedo_provider_credential` (`provider_id`);
--> statement-breakpoint
CREATE INDEX `claxedo_provider_credential_status_idx` ON `claxedo_provider_credential` (`status`);
--> statement-breakpoint
CREATE INDEX `claxedo_provider_credential_updated_idx` ON `claxedo_provider_credential` (`updated_at`);
--> statement-breakpoint

-- Network policy: explicit outbound allowlist for sandboxes and remote workspaces
CREATE TABLE `claxedo_network_policy` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text,
  `runner` text,
  `target` text NOT NULL,
  `kind` text NOT NULL,
  `constraints_json` text NOT NULL DEFAULT '{}',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claxedo_network_policy_workspace_idx` ON `claxedo_network_policy` (`workspace_id`);
--> statement-breakpoint
CREATE INDEX `claxedo_network_policy_kind_idx` ON `claxedo_network_policy` (`kind`);
--> statement-breakpoint
CREATE INDEX `claxedo_network_policy_updated_idx` ON `claxedo_network_policy` (`updated_at`);
