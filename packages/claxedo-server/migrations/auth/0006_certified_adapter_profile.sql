-- Narrow the admitted adapter-profile union on "deploymentRelease" to the one
-- certified profile. Existing rows are append-only release history held by
-- restrict foreign keys and are left in place; the guard below refuses any new
-- row outside the certified set.
--
-- The union normally lives in the column CHECK, and narrowing a CHECK means
-- rebuilding the table. That is not available here: D1 enforces foreign keys
-- and gives no way to turn them off (PRAGMA foreign_keys is rejected, and
-- PRAGMA defer_foreign_keys still counts the implicit delete a DROP TABLE
-- performs), while four later tables reference
-- "deploymentRelease" ("deploymentId", "releaseId") on delete restrict:
--
--   0002: deploymentReleaseStateHistory
--   0004: deploymentCutoverCanaryAdmission, deploymentCutoverEvidenceReceipt
--   0005: deploymentRecoveryEpoch
--
-- Dropping the parent while any of them holds a row fails, and they cannot be
-- emptied either — deploymentReleaseStateHistory references itself on delete
-- restrict, so a chain of revisions cannot be deleted in any order. Releases
-- are append-only, so a BEFORE INSERT guard admits exactly the set a narrowed
-- CHECK would and is the enforcement this migration installs instead.

create trigger "deploymentRelease_certified_adapter_profile"
before insert on "deploymentRelease"
when new."adapterProfile" <> 'better-auth-d1'
BEGIN
  select raise(abort, 'deployment release adapter profile is not certified');
end;
