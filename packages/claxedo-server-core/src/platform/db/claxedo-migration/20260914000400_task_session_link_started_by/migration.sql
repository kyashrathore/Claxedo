-- Who asked for a linked attempt, apart from which session: a root's own
-- grant starts as an agent with no session to name. Every link that exists
-- was started by a person from the app.
ALTER TABLE `claxedo_task_session_link` ADD `started_by` text DEFAULT 'person' NOT NULL;
