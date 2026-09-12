-- When a human last started a turn on a session.
--
-- `updated_at` moves for any actor's turn -- a wake, a subagent, a channel
-- message -- so a session list ordered by it moves rows the reader never spoke
-- to. The turn authority admits exactly one turn per session and is the only
-- place that knows the admitted actor's kind, so it is the only writer of this
-- column; `session_turn_producers` keeps the per-turn provenance beside it.
--
-- Nullable with no backfill. A session registered before this column has no
-- recorded prompt, and "never prompted" is the only thing the store can
-- honestly say about it -- which is also where the list puts it, below every
-- session that has one.

alter table sessions add column last_human_turn_at integer;
