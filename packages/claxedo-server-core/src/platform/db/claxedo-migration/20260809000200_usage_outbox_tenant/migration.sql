ALTER TABLE `claxedo_usage_outbox` ADD COLUMN `org_id` text;
--> statement-breakpoint
ALTER TABLE `claxedo_usage_outbox` ADD COLUMN `user_id` text;
--> statement-breakpoint
CREATE INDEX `claxedo_usage_outbox_tenant_state_created_idx` ON `claxedo_usage_outbox` (`org_id`, `user_id`, `state`, `created_at`);
