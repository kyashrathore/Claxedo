-- Every pass the control plane mints for a sandbox, by its `jti`, so one can be
-- refused before its `exp` without the token in hand: the Tasks capability
-- when its project turns Tasks off or its workspace is deleted, and the Agent
-- Plugins gateway token with it. `revoked_at` is the revocation; a row that
-- never gets one expires on its own and is pruned at the next mint.
--
-- No foreign key to `workspaces`: a pass outlives nothing the workspace row
-- decides, and the owner recheck at every use already refuses a deleted row.

create table sandbox_passes (
  jti text primary key,
  audience text not null,
  user_id text not null,
  org_id text not null,
  project_id text,
  workspace_id text not null,
  session_id text,
  issued_at integer not null,
  expires_at integer not null,
  revoked_at integer,
  revoked_reason text
);

create index sandbox_passes_workspace_idx on sandbox_passes (workspace_id, audience);

create index sandbox_passes_org_idx on sandbox_passes (org_id, audience, expires_at);
