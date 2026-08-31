-- Artifact identities and state transitions are append-only. Only the active
-- pointer may change, through a compare-and-swap operation.

create table "deploymentRelease" (
  "deploymentId" text not null,
  "releaseSequence" integer not null check ("releaseSequence" > 0),
  "releaseId" text not null,
  "workerBuildId" text not null,
  "platformVersionId" text not null,
  "browserBuildId" text not null,
  "relayBuildId" text not null,
  "authConfigurationId" text not null,
  "requestLimiterNamespaceId" text not null,
  "adapterProfile" text not null check ("adapterProfile" in ('better-auth-d1', 'clerk-convex')),
  "productPosture" text not null check ("productPosture" in ('claxedo-hosted', 'user-deployed')),
  "sandboxPosture" text not null check ("sandboxPosture" in ('control-plane-only', 'full-hosted')),
  "serviceManifestId" text not null,
  "createdAt" text not null,
  primary key ("deploymentId", "releaseId"),
  unique ("deploymentId", "releaseSequence")
);

create table "deploymentReleaseStateHistory" (
  "deploymentId" text not null,
  "stateRevision" integer not null check ("stateRevision" >= 0),
  "operationId" text not null,
  "releaseId" text not null,
  "previousStateRevision" integer,
  "restoredStateRevision" integer,
  "transitionKind" text not null check (
    "transitionKind" in (
      'initialize', 'open_rollforward', 'locked_replacement', 'prewrite_rollback',
      'phase_transition', 'first_target_write'
    )
  ),
  "phase" text not null check (
    "phase" in ('locked', 'canary', 'provider_sync', 'multiplayer_validation', 'open')
  ),
  "phaseRevision" integer not null check ("phaseRevision" >= 0),
  "firstTargetWriteAt" text,
  "createdAt" text not null,
  primary key ("deploymentId", "stateRevision"),
  unique ("deploymentId", "operationId"),
  foreign key ("deploymentId", "releaseId")
    references "deploymentRelease" ("deploymentId", "releaseId") on delete restrict,
  foreign key ("deploymentId", "previousStateRevision")
    references "deploymentReleaseStateHistory" ("deploymentId", "stateRevision") on delete restrict,
  foreign key ("deploymentId", "restoredStateRevision")
    references "deploymentReleaseStateHistory" ("deploymentId", "stateRevision") on delete restrict,
  check (
    ("stateRevision" = 0 and "previousStateRevision" is null) or
    ("stateRevision" > 0 and "previousStateRevision" = "stateRevision" - 1)
  ),
  check (
    ("transitionKind" = 'prewrite_rollback' and "restoredStateRevision" is not null) or
    ("transitionKind" <> 'prewrite_rollback' and "restoredStateRevision" is null)
  ),
  check (
    ("phase" = 'locked' and "phaseRevision" = 0 and "firstTargetWriteAt" is null) or
    "phase" = 'canary' or
    ("phase" in ('provider_sync', 'multiplayer_validation', 'open') and "firstTargetWriteAt" is not null)
  )
);

create table "deploymentReleaseActive" (
  "singleton" integer not null primary key check ("singleton" = 1),
  "deploymentId" text not null,
  "stateRevision" integer not null,
  "updatedAt" text not null,
  foreign key ("deploymentId", "stateRevision")
    references "deploymentReleaseStateHistory" ("deploymentId", "stateRevision") on delete restrict
);

create trigger "deploymentRelease_no_update"
before update on "deploymentRelease"
BEGIN
  select raise(abort, 'deployment releases are append-only');
end;

create trigger "deploymentRelease_no_delete"
before delete on "deploymentRelease"
BEGIN
  select raise(abort, 'deployment releases are append-only');
end;

create trigger "deploymentReleaseStateHistory_no_update"
before update on "deploymentReleaseStateHistory"
BEGIN
  select raise(abort, 'deployment release history is append-only');
end;

create trigger "deploymentReleaseStateHistory_no_delete"
before delete on "deploymentReleaseStateHistory"
BEGIN
  select raise(abort, 'deployment release history is append-only');
end;
