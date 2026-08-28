-- Mirror of AUTH_DB deploymentRecoveryEpoch. Cross-database atomicity does not
-- exist in D1, so every hosted boot reads both rows and fails closed on drift.

create table control_plane_recovery_epochs (
  deployment_id text not null,
  release_id text not null,
  recovery_epoch text not null unique check (
    length(recovery_epoch) = 84 and recovery_epoch like 'paired-d1-v1:sha256:%'
      and substr(recovery_epoch, 21) not glob '*[^0-9a-f]*'
  ),
  created_at text not null,
  primary key (deployment_id, release_id)
);

create trigger control_plane_recovery_epochs_no_update
before update on control_plane_recovery_epochs
begin
  select raise(abort, 'control-plane recovery epochs are append-only');
end;

create trigger control_plane_recovery_epochs_no_delete
before delete on control_plane_recovery_epochs
begin
  select raise(abort, 'control-plane recovery epochs are append-only');
end;
