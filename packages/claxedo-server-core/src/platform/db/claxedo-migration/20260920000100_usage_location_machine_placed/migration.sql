-- `location` is a plain text column: nothing in SQLite rejects a word the
-- contract no longer lists. A row left unrewritten reaches `usageLocation`,
-- which answers `cloud` for every word it does not recognise, so a turn run on
-- the owner's own machine would be billed and charted as a cloud turn.
UPDATE `claxedo_usage_turn_revision` SET `location` = 'local' WHERE `location` = 'user-hosted';
--> statement-breakpoint
UPDATE `claxedo_usage_turn_current` SET `location` = 'local' WHERE `location` = 'user-hosted';
