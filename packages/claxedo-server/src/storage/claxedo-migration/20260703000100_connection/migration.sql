CREATE TABLE IF NOT EXISTS `claxedo_connection` (
  `integration_id` text PRIMARY KEY NOT NULL,
  `account_label` text,
  `granted_capabilities` text NOT NULL,
  `fields` text NOT NULL DEFAULT '{}',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
