UPDATE `claxedo_provider_account_source` SET `source` = 'org' WHERE `source` = 'team';
--> statement-breakpoint
DROP INDEX `claxedo_connection_team_integration_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `claxedo_connection_org_integration_unique` ON `claxedo_connection` (`integration_id`) WHERE `owner` IS NULL;
