ALTER TABLE `claxedo_cloud_message`
ADD COLUMN `event_ordinal` integer NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT
    `message_id`,
    ROW_NUMBER() OVER (
      PARTITION BY `session_id`
      ORDER BY `created_at`, `message_id`
    ) AS `event_ordinal`
  FROM `claxedo_cloud_message`
)
UPDATE `claxedo_cloud_message`
SET `event_ordinal` = (
  SELECT ranked.`event_ordinal`
  FROM ranked
  WHERE ranked.`message_id` = `claxedo_cloud_message`.`message_id`
);

CREATE INDEX IF NOT EXISTS `claxedo_cloud_message_event_ordinal_idx`
ON `claxedo_cloud_message` (`session_id`, `event_ordinal`);
