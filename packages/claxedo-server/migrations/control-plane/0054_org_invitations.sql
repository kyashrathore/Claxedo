create table org_invitations (
  id text primary key,
  org_id text not null references orgs(org_id),
  email text not null check (email = lower(trim(email))),
  role text not null check (role in ('member', 'admin', 'owner')),
  token_hash text not null unique,
  invited_by text not null references users(user_id),
  created_at integer not null,
  expires_at integer not null,
  accepted_at integer,
  revoked_at integer
);

create index org_invitations_org on org_invitations(org_id, created_at);

create table org_invitation_admissions (
  user_id text primary key references users(user_id) on delete cascade,
  invitation_id text not null references org_invitations(id)
);
