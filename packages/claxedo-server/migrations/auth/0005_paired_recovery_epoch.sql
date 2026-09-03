-- A Better Auth and control-plane D1 pair is restored and admitted together.
-- The Worker validates the exact active release against both databases.

create table "deploymentRecoveryEpoch" (
  "deploymentId" text not null,
  "releaseId" text not null,
  "recoveryEpoch" text not null unique check (
    length("recoveryEpoch") = 84 and "recoveryEpoch" like 'paired-d1-v1:sha256:%'
      and substr("recoveryEpoch", 21) not glob '*[^0-9a-f]*'
  ),
  "createdAt" text not null,
  primary key ("deploymentId", "releaseId"),
  foreign key ("deploymentId", "releaseId")
    references "deploymentRelease" ("deploymentId", "releaseId") on delete restrict
);

create trigger "deploymentRecoveryEpoch_no_update"
before update on "deploymentRecoveryEpoch"
BEGIN
  select raise(abort, 'deployment recovery epochs are append-only');
end;

create trigger "deploymentRecoveryEpoch_no_delete"
before delete on "deploymentRecoveryEpoch"
BEGIN
  select raise(abort, 'deployment recovery epochs are append-only');
end;
