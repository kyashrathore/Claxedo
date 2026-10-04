CREATE INDEX IF NOT EXISTS `claxedo_usage_turn_current_settlement_idx`
ON `claxedo_usage_turn_current` (`settlement`);

CREATE INDEX IF NOT EXISTS `claxedo_usage_turn_current_session_message_idx`
ON `claxedo_usage_turn_current` (`session_id`, `message_id`);
