-- Whether an agent inside a session may start this preset. Off for every
-- preset that exists, because no person has marked one yet.
ALTER TABLE `claxedo_task_preset` ADD `agent_startable` integer DEFAULT 0 NOT NULL;
