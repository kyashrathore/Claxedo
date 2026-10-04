CREATE TABLE `claxedo_user_agent_config` (
  `user_id` text PRIMARY KEY NOT NULL,
  `config_json` text NOT NULL,
  `updated_at` integer NOT NULL
);
