-- A subtask is filed under its parent's number with a child number of its own
-- (`20.1`), so the unique index widens to the pair. Existing subtasks held a
-- project number of their own; each takes its parent's, and its place among
-- the parent's children by creation order becomes its child number. The index
-- is dropped first because a child's new pair can equal a root's old number
-- until every row is rewritten.
ALTER TABLE `claxedo_task` ADD `child_number` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `claxedo_task_number_idx`;
--> statement-breakpoint
UPDATE `claxedo_task` SET `child_number` = (
	SELECT count(*) FROM `claxedo_task` AS `sibling`
	WHERE `sibling`.`scope_id` = `claxedo_task`.`scope_id`
		AND `sibling`.`parent_task_id` = `claxedo_task`.`parent_task_id`
		AND (`sibling`.`created_at` < `claxedo_task`.`created_at`
			OR (`sibling`.`created_at` = `claxedo_task`.`created_at` AND `sibling`.`task_id` <= `claxedo_task`.`task_id`))
) WHERE `parent_task_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `claxedo_task` SET `number` = (
	SELECT `parent`.`number` FROM `claxedo_task` AS `parent`
	WHERE `parent`.`scope_id` = `claxedo_task`.`scope_id` AND `parent`.`task_id` = `claxedo_task`.`parent_task_id`
) WHERE `parent_task_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `claxedo_task_number_idx` ON `claxedo_task` (`scope_id`,`project_id`,`number`,`child_number`);
