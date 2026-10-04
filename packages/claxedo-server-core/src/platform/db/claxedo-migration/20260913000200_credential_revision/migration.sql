-- Which stored secret a brokered request used.
--
-- A binding reported its revision as `updated_at`, so two writes in the same
-- millisecond were indistinguishable and a 401 raised against the superseded
-- value withdrew the account that replaced it. Existing rows start at 1: no
-- placeholder minted before this column exists names a revision, so there is
-- nothing for a backfill to keep in step with.
ALTER TABLE `claxedo_provider_credential` ADD `revision` integer DEFAULT 1 NOT NULL;
