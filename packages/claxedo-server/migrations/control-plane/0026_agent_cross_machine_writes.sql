-- "Agents may act on my other machines", one row per account.
--
-- Read when a cloud root's Tasks grant is minted: `start` is granted only to
-- an owner whose row holds 1, and an absent row answers the same as 0, so
-- nobody is opted in by never having visited Settings. No foreign key to
-- `users`: a preference must not be a reason a user row cannot be removed.

create table user_agent_settings (
  user_id text not null primary key,
  cross_machine_writes integer not null default 0 check (cross_machine_writes in (0, 1)),
  updated_at integer not null
);

-- Whether an agent inside a session may start this preset. Off for every
-- preset that exists, because no person has marked one yet.

alter table task_presets add column agent_startable integer not null default 0;
