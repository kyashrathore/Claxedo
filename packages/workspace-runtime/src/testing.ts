import type { MachineLoginPolicy } from "@claxedo/harness/contract"
import type { WorkspaceRuntimeManagementAuth } from "./management-auth"

/** The placement a test host runs under: the machine's own loopback, whose owner may spend its logins. */
export function loopbackMachineLoginPolicy(machineOwnerUserId = "test-owner"): MachineLoginPolicy {
  return { placement: "loopback", machineOwnerUserId, canUseOwnLogin: true }
}
export { WorkspaceScope, createOpenCodeRuntime, type OpenCodeRuntime } from "@claxedo/harness/opencode-sdk"
export { FAKE_CONNECTION_CAPABILITIES, FAKE_TRANSPORT_CAPABILITIES, FakeTransport, fakeConnectionProvider, type FakeTransportOptions, type FakeTurn } from "./test-support/fake-transport"
export {
  createOpenCodeFixtureIds,
  importOpenCodeFixtureSessions,
  openCodePartId,
  type OpenCodeFixtureSession,
  type OpenCodeFixtureReadback,
} from "@claxedo/harness/testing/opencode"

export function allowWorkspaceRuntimeManagementAuth(subject = "test"): WorkspaceRuntimeManagementAuth {
  return {
    async authorize() {
      return { ok: true, subject, scopes: ["runtime.config.apply"] }
    },
  }
}
