ALTER TABLE `claxedo_workspace_lease` ADD COLUMN `checkpoint` text;
ALTER TABLE `claxedo_workspace_lease` ADD COLUMN `persistence_capabilities` text;
ALTER TABLE `claxedo_workspace_lease` ADD COLUMN `restore_status` text;
ALTER TABLE `claxedo_workspace_lease` ADD COLUMN `labels` text;
