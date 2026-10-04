-- When an account was last chosen, as its own fact.
--
-- Delivery resolves a destination two marked accounts both answer on by taking
-- the one the operator stated most recently, and it read `updated_at` for that.
-- A health check and a rename both stamp `updated_at`, so checking one alias
-- moved a shared vendor host to it without anyone choosing it.
--
-- Backfilled from `updated_at` for the rows that hold a mark: it is the best
-- record of the choice that exists, and it is exactly what the reader used
-- until now. A row with no mark gets NULL, because it was never chosen.
ALTER TABLE `claxedo_provider_credential` ADD `activated_at` integer;
--> statement-breakpoint
UPDATE `claxedo_provider_credential` SET `activated_at` = `updated_at` WHERE `is_active` = 1;
