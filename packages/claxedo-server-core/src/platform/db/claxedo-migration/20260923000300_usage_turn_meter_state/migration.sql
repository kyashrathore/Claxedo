CREATE TABLE `claxedo_usage_turn_meter_state` (
  `session_id` text NOT NULL,
  `message_id` text NOT NULL,
  `streams_json` text NOT NULL,
  `observation_keys_json` text NOT NULL,
  PRIMARY KEY (`session_id`, `message_id`)
);
