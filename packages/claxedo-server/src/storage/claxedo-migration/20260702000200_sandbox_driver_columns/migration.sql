ALTER TABLE `claxedo_workspace_lease`
  RENAME COLUMN `provider` TO `driver`;

ALTER TABLE `claxedo_workspace_lease`
  RENAME COLUMN `provider_object_id` TO `driver_resource_id`;

ALTER TABLE `claxedo_workspace_lease`
  RENAME COLUMN `provider_snapshot_id` TO `driver_snapshot_id`;

ALTER TABLE `claxedo_runtime_snapshot`
  RENAME COLUMN `provider_snapshot_id` TO `driver_snapshot_id`;
