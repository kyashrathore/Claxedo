-- How much of a plan is spent, kept between reads.
--
-- The windows a provider reports were handed to the caller of a Check and
-- dropped, so the Providers list showed usage until the page read again and
-- then lost it. Existing rows are left NULL: nothing was stored before this
-- column, and an empty array would read as a plan with nothing spent.
ALTER TABLE `claxedo_provider_credential` ADD `usage_windows` text;
--> statement-breakpoint
ALTER TABLE `claxedo_provider_credential` ADD `usage_at` integer;
--> statement-breakpoint
-- The same answer for a login a harness on this machine holds. No org or owner
-- column: the CLI is installed beside the process, the route that reads it is
-- loopback-only, and `account` is `''` rather than NULL for a harness that
-- names no address, because NULLs are distinct in a SQLite key.
CREATE TABLE `claxedo_machine_login_usage` (
	`harness` text NOT NULL,
	`account` text NOT NULL,
	`usage_windows` text NOT NULL,
	`usage_at` integer NOT NULL,
	PRIMARY KEY(`harness`, `account`)
);
