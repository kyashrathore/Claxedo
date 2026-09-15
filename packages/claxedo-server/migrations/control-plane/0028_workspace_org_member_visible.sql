-- Whether an ordinary org member gets the implicit viewer rank on this
-- workspace. Assignment writes it from the serving enrollment's scope; direct,
-- project, team and org-admin access do not read it.
alter table workspaces add column org_member_visible integer not null default 1
  check (org_member_visible in (0, 1));
