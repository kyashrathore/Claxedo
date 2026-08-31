-- Durable, release-bound cutover admission and evidence. These rows are
-- append-only operator receipts; phase changes remain owned by
-- deploymentReleaseStateHistory.

create table "deploymentCutoverCanaryAdmission" (
  "deploymentId" text not null,
  "releaseId" text not null,
  "workerBuildId" text not null,
  "platformVersionId" text not null,
  "browserBuildId" text not null,
  "relayBuildId" text not null,
  "authConfigurationId" text not null,
  "adapterProfile" text not null,
  "productPosture" text not null,
  "sandboxPosture" text not null,
  "serviceManifestId" text not null,
  "sourceStateRevision" integer not null check ("sourceStateRevision" >= 0),
  "sourcePhaseRevision" integer not null check ("sourcePhaseRevision" >= 0),
  "receiptId" text not null,
  "operationId" text not null,
  "operatorSubjectHash" text not null check (
    length("operatorSubjectHash") = 71 and "operatorSubjectHash" like 'sha256:%'
      and substr("operatorSubjectHash", 8) not glob '*[^0-9a-f]*'
  ),
  "canaryIdentityHash" text not null check (
    length("canaryIdentityHash") = 71 and "canaryIdentityHash" like 'sha256:%'
      and substr("canaryIdentityHash", 8) not glob '*[^0-9a-f]*'
  ),
  "journeyId" text not null,
  "createdAt" text not null,
  primary key ("deploymentId", "releaseId"),
  unique ("deploymentId", "receiptId"),
  unique ("deploymentId", "operationId"),
  foreign key ("deploymentId", "releaseId")
    references "deploymentRelease" ("deploymentId", "releaseId") on delete restrict
);

create table "deploymentCutoverEvidenceReceipt" (
  "deploymentId" text not null,
  "releaseId" text not null,
  "workerBuildId" text not null,
  "platformVersionId" text not null,
  "browserBuildId" text not null,
  "relayBuildId" text not null,
  "authConfigurationId" text not null,
  "adapterProfile" text not null,
  "productPosture" text not null,
  "sandboxPosture" text not null,
  "serviceManifestId" text not null,
  "sourceStateRevision" integer not null check ("sourceStateRevision" >= 0),
  "sourcePhaseRevision" integer not null check ("sourcePhaseRevision" >= 0),
  "receiptId" text not null,
  "operationId" text not null,
  "evidenceKind" text not null check ("evidenceKind" in (
    'migration_conservation_verified', 'greenfield_source_absence_verified',
    'canary_first_write', 'canary_journey_complete',
    'callback_capture_ready', 'callback_inbox_drained', 'authority_reconciled',
    'billing_closure_absent', 'polar_reconciled', 'paired_backup_verified',
    'multiplayer_identity', 'private_session_verified', 'stream_verified',
    'revocation_verified', 'wrong_org_verified', 'replay_verified', 'outage_verified'
  )),
  "evidenceSlot" integer not null default 0 check ("evidenceSlot" in (0, 1, 2)),
  "primarySubjectHash" text,
  "secondarySubjectHash" text,
  "observedCount" integer,
  "evidenceReference" text,
  "recoveryEpoch" text,
  "artifactSha256" text,
  "secondaryArtifactSha256" text,
  "createdAt" text not null,
  primary key ("deploymentId", "releaseId", "evidenceKind", "evidenceSlot"),
  unique ("deploymentId", "receiptId"),
  unique ("deploymentId", "operationId"),
  foreign key ("deploymentId", "releaseId")
    references "deploymentRelease" ("deploymentId", "releaseId") on delete restrict,
  check (
    ("primarySubjectHash" is null or
      (length("primarySubjectHash") = 71 and "primarySubjectHash" like 'sha256:%'
        and substr("primarySubjectHash", 8) not glob '*[^0-9a-f]*')) and
    ("secondarySubjectHash" is null or
      (length("secondarySubjectHash") = 71 and "secondarySubjectHash" like 'sha256:%'
        and substr("secondarySubjectHash", 8) not glob '*[^0-9a-f]*')) and
    ("artifactSha256" is null or
      (length("artifactSha256") = 71 and "artifactSha256" like 'sha256:%'
        and substr("artifactSha256", 8) not glob '*[^0-9a-f]*')) and
    ("secondaryArtifactSha256" is null or
      (length("secondaryArtifactSha256") = 71 and "secondaryArtifactSha256" like 'sha256:%'
        and substr("secondaryArtifactSha256", 8) not glob '*[^0-9a-f]*'))
  ),
  check (
    ("evidenceKind" = 'multiplayer_identity' and "evidenceSlot" in (1, 2)) or
    ("evidenceKind" <> 'multiplayer_identity' and "evidenceSlot" = 0)
  ),
  check (
    ("evidenceKind" in ('migration_conservation_verified', 'greenfield_source_absence_verified')
      and "primarySubjectHash" is null and "secondarySubjectHash" is null
      and "observedCount" is null and "evidenceReference" is not null
      and "recoveryEpoch" is null and "artifactSha256" is not null
      and "secondaryArtifactSha256" is not null)
    or
    ("evidenceKind" in ('canary_first_write', 'canary_journey_complete', 'multiplayer_identity')
      and "primarySubjectHash" is not null and "secondarySubjectHash" is null
      and "observedCount" is null and "evidenceReference" is null and "recoveryEpoch" is null
      and "artifactSha256" is null and "secondaryArtifactSha256" is null)
    or
    ("evidenceKind" in ('callback_capture_ready', 'billing_closure_absent')
      and "primarySubjectHash" is null and "secondarySubjectHash" is null
      and "observedCount" is null and "evidenceReference" is null and "recoveryEpoch" is null
      and "artifactSha256" is null and "secondaryArtifactSha256" is null)
    or
    ("evidenceKind" in ('callback_inbox_drained', 'authority_reconciled', 'polar_reconciled')
      and "primarySubjectHash" is null and "secondarySubjectHash" is null
      and "observedCount" = 0 and "evidenceReference" is null and "recoveryEpoch" is null
      and "artifactSha256" is null and "secondaryArtifactSha256" is null)
    or
    ("evidenceKind" = 'paired_backup_verified'
      and "primarySubjectHash" is null and "secondarySubjectHash" is null
      and "observedCount" is null and "evidenceReference" is null and "recoveryEpoch" is not null
      and "artifactSha256" is not null and "secondaryArtifactSha256" is not null)
    or
    ("evidenceKind" in ('private_session_verified', 'stream_verified', 'revocation_verified',
        'wrong_org_verified', 'replay_verified', 'outage_verified')
      and "primarySubjectHash" is not null and "secondarySubjectHash" is not null
      and "primarySubjectHash" <> "secondarySubjectHash"
      and "observedCount" is null and "evidenceReference" is null and "recoveryEpoch" is null
      and "artifactSha256" is null and "secondaryArtifactSha256" is null)
  )
);

create unique index "deploymentCutoverEvidence_distinct_multiplayer_identity"
  on "deploymentCutoverEvidenceReceipt" ("deploymentId", "releaseId", "primarySubjectHash")
  where "evidenceKind" = 'multiplayer_identity';

create unique index "deploymentCutoverEvidence_one_source_boundary"
  on "deploymentCutoverEvidenceReceipt" ("deploymentId", "releaseId")
  where "evidenceKind" in ('migration_conservation_verified', 'greenfield_source_absence_verified');

create trigger "deploymentCutoverCanaryAdmission_no_update"
before update on "deploymentCutoverCanaryAdmission"
BEGIN
  select raise(abort, 'cutover canary admissions are append-only');
end;

create trigger "deploymentCutoverCanaryAdmission_no_delete"
before delete on "deploymentCutoverCanaryAdmission"
BEGIN
  select raise(abort, 'cutover canary admissions are append-only');
end;

create trigger "deploymentCutoverEvidenceReceipt_no_update"
before update on "deploymentCutoverEvidenceReceipt"
BEGIN
  select raise(abort, 'cutover evidence receipts are append-only');
end;

create trigger "deploymentCutoverEvidenceReceipt_no_delete"
before delete on "deploymentCutoverEvidenceReceipt"
BEGIN
  select raise(abort, 'cutover evidence receipts are append-only');
end;
