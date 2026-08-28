export type DocumentsServiceLifecycleAction =
  "install" | "enable" | "disable" | "drain" | "revoke" | "unbind" | "uninstall"

export type DocumentsServiceLifecycleStep = Readonly<{
  owner: "documents-service" | "core"
  action:
    | "provision_service_resources"
    | "apply_service_migrations"
    | "initialize_service_disabled"
    | "deploy_service_dark"
    | "register_core_disabled"
    | "deploy_core_binding"
    | "probe_service_disabled"
    | "enable_service"
    | "enable_core_catalog"
    | "disable_core_catalog"
    | "drain_core_operations"
    | "disable_service"
    | "revoke_core_bridge"
    | "remove_core_binding"
    | "mark_service_uninstalled"
    | "unregister_core"
    | "retire_service_resources"
}>

const workflows = {
  install: [
    { owner: "documents-service", action: "provision_service_resources" },
    { owner: "documents-service", action: "apply_service_migrations" },
    { owner: "documents-service", action: "initialize_service_disabled" },
    { owner: "documents-service", action: "deploy_service_dark" },
    { owner: "core", action: "register_core_disabled" },
    { owner: "core", action: "deploy_core_binding" },
    { owner: "core", action: "probe_service_disabled" },
  ],
  enable: [
    { owner: "core", action: "probe_service_disabled" },
    { owner: "documents-service", action: "enable_service" },
    { owner: "core", action: "enable_core_catalog" },
  ],
  disable: [
    { owner: "core", action: "disable_core_catalog" },
    { owner: "core", action: "drain_core_operations" },
    { owner: "documents-service", action: "disable_service" },
    { owner: "core", action: "revoke_core_bridge" },
  ],
  drain: [{ owner: "core", action: "drain_core_operations" }],
  revoke: [{ owner: "core", action: "revoke_core_bridge" }],
  unbind: [
    { owner: "core", action: "drain_core_operations" },
    { owner: "core", action: "revoke_core_bridge" },
    { owner: "core", action: "remove_core_binding" },
  ],
  uninstall: [
    { owner: "core", action: "drain_core_operations" },
    { owner: "core", action: "revoke_core_bridge" },
    { owner: "core", action: "remove_core_binding" },
    { owner: "documents-service", action: "mark_service_uninstalled" },
    { owner: "core", action: "unregister_core" },
    { owner: "documents-service", action: "retire_service_resources" },
  ],
} as const satisfies Record<DocumentsServiceLifecycleAction, readonly DocumentsServiceLifecycleStep[]>

export function documentsServiceLifecycleWorkflow(action: DocumentsServiceLifecycleAction) {
  return Object.freeze(workflows[action].map((step) => Object.freeze(step)))
}
