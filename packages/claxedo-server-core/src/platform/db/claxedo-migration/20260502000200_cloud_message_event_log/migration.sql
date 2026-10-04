CREATE TABLE IF NOT EXISTS `claxedo_cloud_message_event` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `directory` text,
  `event_ordinal` integer NOT NULL,
  `type` text NOT NULL,
  `data` text NOT NULL,
  `created_at` integer NOT NULL
);

CREATE INDEX IF NOT EXISTS `claxedo_cloud_message_event_session_idx`
ON `claxedo_cloud_message_event` (`session_id`, `event_ordinal`);

INSERT OR IGNORE INTO `claxedo_cloud_message_event`
  (`id`, `session_id`, `directory`, `event_ordinal`, `type`, `data`, `created_at`)
SELECT
  `message_id` || ':snapshot',
  `session_id`,
  (
    SELECT `directory`
    FROM `claxedo_cloud_session`
    WHERE `claxedo_cloud_session`.`session_id` = `claxedo_cloud_message`.`session_id`
  ),
  `event_ordinal`,
  'message.updated',
  json_object(
    'type', 'message.updated',
    'properties', json_object('info', json_extract(`data`, '$.info'))
  ),
  `created_at`
FROM `claxedo_cloud_message`
WHERE `event_ordinal` > 0;
