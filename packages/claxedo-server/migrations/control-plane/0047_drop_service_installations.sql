-- The control plane installs and deploys no separate services, so nothing
-- reads or writes the installation catalog or its deployment receipts.
-- SQLite drops each table's indexes and triggers with it.

drop table service_installation_audit;

drop table service_installations;

drop table service_deployment_steps;

drop table service_deployment_locks;
