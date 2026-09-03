export type WorkGraphServiceLifecycleAction =
  "install" | "enable" | "disable" | "drain" | "revoke" | "unbind" | "uninstall"

export type WorkGraphServiceLifecycleStep = Readonly<{
  owner: "workgraph-service" | "core"
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
    { owner: "workgraph-service", action: "provision_service_resources" },
    { owner: "workgraph-service", action: "apply_service_migrations" },
    { owner: "workgraph-service", action: "initialize_service_disabled" },
    { owner: "workgraph-service", action: "deploy_service_dark" },
    { owner: "core", action: "register_core_disabled" },
    { owner: "core", action: "deploy_core_binding" },
    { owner: "core", action: "probe_service_disabled" },
  ],
  enable: [
    { owner: "core", action: "probe_service_disabled" },
    { owner: "workgraph-service", action: "enable_service" },
    { owner: "core", action: "enable_core_catalog" },
  ],
  disable: [
    { owner: "core", action: "disable_core_catalog" },
    { owner: "core", action: "drain_core_operations" },
    { owner: "workgraph-service", action: "disable_service" },
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
    { owner: "workgraph-service", action: "mark_service_uninstalled" },
    { owner: "core", action: "unregister_core" },
    { owner: "workgraph-service", action: "retire_service_resources" },
  ],
} as const satisfies Record<WorkGraphServiceLifecycleAction, readonly WorkGraphServiceLifecycleStep[]>

export function workGraphServiceLifecycleWorkflow(action: WorkGraphServiceLifecycleAction) {
  return Object.freeze(workflows[action].map((step) => Object.freeze(step)))
}
