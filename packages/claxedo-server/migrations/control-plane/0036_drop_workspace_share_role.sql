-- A workspace folder is not a thing a person is added to: the only
-- cross-person grant is a session share, and organization standing decides
-- only who may be offered one. A rank on a workspace is composed from its
-- owner, its project, the organization and a team's project grant; the
-- membership union had no producer at all -- no route, adapter or migration
-- ever inserted into the view or the table behind it -- so the grants, the
-- view, its write triggers and the direct table all go together.

drop trigger workspace_memberships_insert;

drop trigger workspace_memberships_update;

drop trigger workspace_memberships_delete;

drop view workspace_memberships;

drop table workspace_share_grants;

drop table workspace_direct_memberships;
