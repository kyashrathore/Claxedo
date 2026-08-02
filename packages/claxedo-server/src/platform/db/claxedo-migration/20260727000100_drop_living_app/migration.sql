-- Drops the three tables created by the removed 20260507000000_living_app
-- migration. The routes, Drizzle schema, and that migration are all deleted;
-- nothing ever wrote to these tables (the feature had no producer), so there is
-- no data to preserve and no backward compatibility to keep.
--
-- The `20260507000000_living_app` row in `__claxedo_migrations` is deliberately
-- left in place: the ledger is the only thing telling an older build that the
-- create already ran, so deleting the row is what would let a downgrade re-run
-- `CREATE TABLE IF NOT EXISTS` and resurrect these tables.
DROP TABLE IF EXISTS `claxedo_living_app_event`;
--> statement-breakpoint
DROP TABLE IF EXISTS `claxedo_living_app_data_source`;
--> statement-breakpoint
DROP TABLE IF EXISTS `claxedo_living_app`;
