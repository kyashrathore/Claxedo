ALTER TABLE `claxedo_provider_credential` ADD `scope` text NOT NULL DEFAULT 'local';
--> statement-breakpoint
ALTER TABLE `claxedo_provider_credential` ADD `consent_json` text;
--> statement-breakpoint
ALTER TABLE `claxedo_provider_credential` ADD `last_used_at` integer;
--> statement-breakpoint
UPDATE `claxedo_provider_credential` SET `scope` = 'local';
