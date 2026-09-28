create table user_agent_config (
  user_id text primary key references users (user_id),
  config_json text not null,
  updated_at integer not null
);
