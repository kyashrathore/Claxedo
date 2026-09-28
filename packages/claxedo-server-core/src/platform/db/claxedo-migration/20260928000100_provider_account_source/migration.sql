CREATE TABLE `claxedo_provider_account_source` (
  `org_id` text NOT NULL,
  `user_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `source` text NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`org_id`, `user_id`, `provider_id`)
);
