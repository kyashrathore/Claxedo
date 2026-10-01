-- The runtime's `time.updated` on the newest session metadata the runtime sent,
-- null until it sends one. A metadata write older than it keeps the stored title.
alter table sessions add column runtime_updated_at integer;
