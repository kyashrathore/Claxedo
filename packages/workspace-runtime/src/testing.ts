import type { MachineLoginPolicy } from "@claxedo/harness/contract"
import type { WorkspaceRuntimeManagementAuth } from "./management-auth"

/** The placement a test host runs under: the machine's own loopback, whose owner may spend its logins. */
export function loopbackMachineLoginPolicy(machineOwnerUserId = "test-owner"): MachineLoginPolicy {
  return { placement: "loopback", machineOwnerUserId, canUseOwnLogin: true }
}
export { withSessionCore } from "./session-context"

export function allowWorkspaceRuntimeManagementAuth(subject = "test"): WorkspaceRuntimeManagementAuth {
  return {
    async authorize() {
      return { ok: true, subject, scopes: ["runtime.config.apply"] }
    },
  }
}
