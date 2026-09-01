-- Hard cut: retire the per-workspace "local host link" grain.
--
-- Machine-wide enrollment (0014 plus `host_enrollments` /
-- `host_enrollment_requests` from 0004) replaced it entirely. A laptop is
-- enrolled once and the owner assigns workspaces to it; routing is
-- owner-assignment AND the machine's heartbeat-acked served set AND a live
-- enrollment lease. Nothing reads these two tables any more, so they go rather
-- than linger as a second, weaker way to reach a local workspace.
--
-- Triggers and indexes are dropped explicitly before their tables. SQLite
-- would drop them with the table, but naming them keeps this migration honest
-- about every object 0004 and 0012 created:
--
--   0004: table/index/trigger for local_host_links, and the first
--         host_attestation_challenges with its expiry index and intent trigger.
--   0012: re-created host_attestation_challenges (unscoped), re-creating that
--         same index and trigger.
--
-- `host_signature_uses` stays. Its CHECK still admits the retired
-- 'local-register' / 'local-heartbeat' domains so historical replay evidence
-- keeps its meaning; the authority no longer writes either one.

drop trigger if exists local_host_link_scope_immutable;

drop index if exists local_host_links_by_workspace_activity;

drop table if exists local_host_links;

drop trigger if exists host_challenge_intent_immutable;

drop index if exists host_attestation_challenges_by_expiry;

drop table if exists host_attestation_challenges;
