ALTER TABLE `claxedo_page` ADD COLUMN `document_id` text;
ALTER TABLE `claxedo_page` ADD COLUMN `document_revision_id` text;

CREATE UNIQUE INDEX IF NOT EXISTS `claxedo_page_document_unique`
  ON `claxedo_page` (`document_id`);
