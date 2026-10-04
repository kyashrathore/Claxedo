CREATE TABLE IF NOT EXISTS `claxedo_channel_delivery` (
  `channel` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `external_user_id` text NOT NULL,
  `received_at` integer NOT NULL,
  `first_seen_at` integer NOT NULL,
  `session_id` text,
  `session_create` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`channel`, `idempotency_key`)
);

CREATE INDEX IF NOT EXISTS `claxedo_channel_delivery_user_day_idx`
  ON `claxedo_channel_delivery` (`channel`, `external_user_id`, `first_seen_at`);

CREATE INDEX IF NOT EXISTS `claxedo_channel_delivery_session_idx`
  ON `claxedo_channel_delivery` (`session_id`);

CREATE TABLE IF NOT EXISTS `claxedo_channel_state` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` integer NOT NULL
);
