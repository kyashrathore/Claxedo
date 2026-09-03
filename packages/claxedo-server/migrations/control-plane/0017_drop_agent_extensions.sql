-- Hard cut: retire the agent-extensions grain.
--
-- Agent Plugins replaced it. A plugin is retained by digest and activated
-- per (user/machine, project, harness); its MCP servers reach the existing
-- Connections domain. Nothing reads these two tables any more — the authority
-- methods, their D1 and Convex adapters, the routes, and the marketplace UI
-- are all gone — so they go rather than linger as a second, weaker way to
-- describe what a workspace runs.
--
-- Triggers and indexes are dropped explicitly before their tables. SQLite
-- would drop them with the table, but naming them keeps this migration honest
-- about every object 0005 created for these two:
--
--   agent_extension_installs: one index, two triggers.
--   agent_extension_policy_overrides: three indexes, one trigger.
--
-- `authority_audit_events`, created by the same 0005, STAYS. It is the
-- provider-neutral audit log every authority writes to, not an
-- extensions-specific table, and historical rows keep their meaning.

drop trigger if exists agent_extension_live_source_immutable;

drop trigger if exists agent_extension_install_scope_immutable;

drop index if exists agent_extension_installs_by_workspace;

drop table if exists agent_extension_installs;

drop trigger if exists agent_extension_policy_scope_immutable;

drop index if exists agent_extension_policies_by_workspace;

drop index if exists agent_extension_policies_by_user;

drop index if exists agent_extension_policies_by_org;

drop table if exists agent_extension_policy_overrides;
