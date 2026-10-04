-- Provider credentials become org-scoped.
--
-- Before this migration `claxedo_provider_credential` had no tenant column, so
-- on a self-hosted box running signed multi-org auth ANY signed-in user could
-- list, read, overwrite, delete, or force-verify ANY other org's provider
-- credentials (model-provider API keys and OAuth tokens). The hosted Worker
-- path was already partitioned per org; this closes the self-host path.
--
-- Backfill choice: every pre-existing row becomes `__local__`, the named
-- single-tenant partition.
--   * Existing self-host installs are single-tenant by construction (there was
--     no org dimension to write), and the unsigned/loopback request path
--     resolves to exactly `__local__` — so those users keep every credential
--     they had, with no re-entry and no re-auth.
--   * Legacy rows carry NO record of who wrote them. Attributing them to a
--     guessed org would hand one tenant's API keys to another — the precise
--     bug being fixed. So on a signed multi-org box legacy rows stay in the
--     inert `__local__` partition (unreachable once a bearer is required) and
--     must be re-entered per org. Failing closed is the only safe direction
--     for an unattributable secret.
--   * NOT NULL rather than nullable: a nullable org would force every predicate
--     to carry an `OR org_id IS NULL` escape hatch, which is the wildcard this
--     migration exists to remove.
ALTER TABLE `claxedo_provider_credential` ADD `org_id` text NOT NULL DEFAULT '__local__';
--> statement-breakpoint
UPDATE `claxedo_provider_credential` SET `org_id` = '__local__' WHERE `org_id` IS NULL OR trim(`org_id`) = '';
--> statement-breakpoint
CREATE INDEX `claxedo_provider_credential_org_idx` ON `claxedo_provider_credential` (`org_id`);
--> statement-breakpoint
CREATE INDEX `claxedo_provider_credential_org_provider_idx` ON `claxedo_provider_credential` (`org_id`, `provider_id`);
