-- Provider-neutral teams and private-session share grants for the D1 authority.
-- Every target is an application-owned ID; provider subjects remain in
-- auth_identities and are resolved before reaching these tables.

create table teams (
  team_id text primary key,
  org_id text not null references orgs (org_id) deferrable initially deferred,
  name text not null,
  is_default integer not null default 0 check (is_default in (0, 1)),
  created_by_user_id text not null references users (user_id) deferrable initially deferred,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer
);

create index teams_by_org
  on teams (org_id, deleted_at, name, team_id);

create unique index teams_one_default_per_org
  on teams (org_id) where is_default = 1 and deleted_at is null;

create table team_memberships (
  team_id text not null references teams (team_id) deferrable initially deferred,
  user_id text not null references users (user_id) deferrable initially deferred,
  role text not null check (role in ('member', 'admin', 'owner')),
  created_at integer not null,
  updated_at integer not null,
  revoked_at integer,
  primary key (team_id, user_id)
);

create index team_memberships_by_user
  on team_memberships (user_id, revoked_at, team_id);

create trigger team_membership_org_scope
before insert on team_memberships
when not exists (
  select 1 from teams t
  join org_memberships om on om.org_id = t.org_id and om.user_id = new.user_id and om.revoked_at is null
  join users u on u.user_id = new.user_id and u.state = 'active'
  where t.team_id = new.team_id and t.deleted_at is null
)
BEGIN
  select raise(abort, 'team member must belong to the team organization');
END;

create table team_project_grants (
  team_id text not null references teams (team_id) deferrable initially deferred,
  project_id text not null references projects (project_id) deferrable initially deferred,
  role text not null check (role in ('viewer', 'editor', 'admin')),
  created_by_user_id text not null references users (user_id) deferrable initially deferred,
  created_at integer not null,
  updated_at integer not null,
  revoked_at integer,
  primary key (team_id, project_id)
);

create index team_project_grants_by_project
  on team_project_grants (project_id, revoked_at, team_id);

create trigger team_project_grant_org_scope
before insert on team_project_grants
when not exists (
  select 1 from teams t
  join projects p on p.project_id = new.project_id and p.org_id = t.org_id and p.deleted_at is null
  where t.team_id = new.team_id and t.deleted_at is null
)
BEGIN
  select raise(abort, 'team project grant belongs to another organization');
END;

create table session_share_grants (
  grant_id text primary key,
  session_id text not null,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  target_user_id text references users (user_id) deferrable initially deferred,
  target_org_id text references orgs (org_id) deferrable initially deferred,
  target_team_id text references teams (team_id) deferrable initially deferred,
  granted_by_actor_id text not null references actors (actor_id) deferrable initially deferred,
  granted_at integer not null,
  revoked_at integer,
  foreign key (session_id, workspace_id, org_id, project_id)
    references sessions (session_id, workspace_id, org_id, project_id) deferrable initially deferred,
  check (
    (target_user_id is not null) +
    (target_org_id is not null) +
    (target_team_id is not null) = 1
  )
);

create index session_share_grants_by_session
  on session_share_grants (session_id, revoked_at, granted_at, grant_id);

create index session_share_grants_by_workspace
  on session_share_grants (workspace_id, revoked_at, grant_id);

create index session_share_grants_by_user
  on session_share_grants (target_user_id, revoked_at, session_id);

create index session_share_grants_by_team
  on session_share_grants (target_team_id, revoked_at, session_id);

create unique index session_share_grants_active_user
  on session_share_grants (session_id, target_user_id)
  where target_user_id is not null and revoked_at is null;

create unique index session_share_grants_active_org
  on session_share_grants (session_id, target_org_id)
  where target_org_id is not null and revoked_at is null;

create unique index session_share_grants_active_team
  on session_share_grants (session_id, target_team_id)
  where target_team_id is not null and revoked_at is null;

create trigger session_share_target_scope
before insert on session_share_grants
when
  (new.target_user_id is not null and not exists (
    select 1 from org_memberships om
    join users u on u.user_id = om.user_id and u.state = 'active'
    where om.org_id = new.org_id and om.user_id = new.target_user_id and om.revoked_at is null
  ))
  or (new.target_org_id is not null and new.target_org_id != new.org_id)
  or (new.target_team_id is not null and not exists (
    select 1 from teams t
    where t.team_id = new.target_team_id and t.org_id = new.org_id and t.deleted_at is null
  ))
BEGIN
  select raise(abort, 'session share target belongs to another organization');
END;

create trigger session_share_intent_immutable
before update of session_id, workspace_id, org_id, project_id,
  target_user_id, target_org_id, target_team_id, granted_by_actor_id, granted_at
on session_share_grants
when new.session_id != old.session_id
  or new.workspace_id != old.workspace_id
  or new.org_id != old.org_id
  or new.project_id != old.project_id
  or new.target_user_id is not old.target_user_id
  or new.target_org_id is not old.target_org_id
  or new.target_team_id is not old.target_team_id
  or new.granted_by_actor_id != old.granted_by_actor_id
  or new.granted_at != old.granted_at
BEGIN
  select raise(abort, 'session share intent is immutable');
END;
