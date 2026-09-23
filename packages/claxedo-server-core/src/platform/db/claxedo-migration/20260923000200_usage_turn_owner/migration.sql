CREATE TABLE `claxedo_usage_turn_owner` (
  `host_id` text NOT NULL,
  `session_ref` text NOT NULL,
  `message_id` text NOT NULL,
  `org_id` text NOT NULL,
  `user_id` text NOT NULL,
  PRIMARY KEY (`host_id`, `session_ref`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `claxedo_usage_turn_owner_account_idx` ON `claxedo_usage_turn_owner` (`org_id`, `user_id`);
--> statement-breakpoint
-- A turn belongs to the account its latest stamped revision named. A turn no
-- revision named an account for is the machine's, and gets no row.
INSERT INTO `claxedo_usage_turn_owner` (`host_id`, `session_ref`, `message_id`, `org_id`, `user_id`)
SELECT `host_id`, `session_ref`, `message_id`, `org_id`, `user_id`
FROM `claxedo_usage_outbox` AS `stamped`
WHERE `org_id` IS NOT NULL AND `user_id` IS NOT NULL
  AND `revision` = (
    SELECT max(`revision`) FROM `claxedo_usage_outbox` AS `later`
    WHERE `later`.`host_id` = `stamped`.`host_id`
      AND `later`.`session_ref` = `stamped`.`session_ref`
      AND `later`.`message_id` = `stamped`.`message_id`
      AND `later`.`org_id` IS NOT NULL
      AND `later`.`user_id` IS NOT NULL
  );
--> statement-breakpoint
DROP TABLE `claxedo_usage_outbox`;
