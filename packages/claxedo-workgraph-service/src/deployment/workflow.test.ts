import { describe, expect, test } from "vitest"

import { workGraphServiceLifecycleWorkflow } from "./workflow"

describe("WorkGraph optional-service lifecycle ordering", () => {
  test("installs dark before the core gains a binding", () => {
    expect(workGraphServiceLifecycleWorkflow("install").map((step) => step.action)).toEqual([
      "provision_service_resources",
      "apply_service_migrations",
      "initialize_service_disabled",
      "deploy_service_dark",
      "register_core_disabled",
      "deploy_core_binding",
      "probe_service_disabled",
    ])
  })

  test("enables the service before core advertisement", () => {
    expect(workGraphServiceLifecycleWorkflow("enable").map((step) => step.action)).toEqual([
      "probe_service_disabled",
      "enable_service",
      "enable_core_catalog",
    ])
  })

  test("disables core forwarding before stopping the service and leaves unbinding explicit", () => {
    expect(workGraphServiceLifecycleWorkflow("disable").map((step) => step.action)).toEqual([
      "disable_core_catalog",
      "drain_core_operations",
      "disable_service",
      "revoke_core_bridge",
    ])
  })

  test("unbinds and uninstalls only after drain and revocation", () => {
    expect(workGraphServiceLifecycleWorkflow("unbind").map((step) => step.action)).toEqual([
      "drain_core_operations",
      "revoke_core_bridge",
      "remove_core_binding",
    ])
    expect(workGraphServiceLifecycleWorkflow("uninstall").map((step) => step.action)).toEqual([
      "drain_core_operations",
      "revoke_core_bridge",
      "remove_core_binding",
      "mark_service_uninstalled",
      "unregister_core",
      "retire_service_resources",
    ])
  })
})
