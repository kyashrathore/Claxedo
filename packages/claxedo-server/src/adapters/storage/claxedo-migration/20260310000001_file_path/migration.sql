-- Add file_path and directory columns for file-backed pages
ALTER TABLE `claxedo_page` ADD COLUMN `file_path` text;--> statement-breakpoint
ALTER TABLE `claxedo_page` ADD COLUMN `directory` text;
