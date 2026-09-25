import type { WorkspaceRuntimeManagementAuth } from "./management-auth"

export { OpenCodeSdkHarnessAdapter } from "./opencode/harness-adapter"
export { WorkspaceScope, createOpenCodeRuntime, type OpenCodeRuntime } from "@claxedo/harness/opencode-sdk"
export { openCodePartId } from "@claxedo/harness/opencode-sdk/session-port"
export {
  createOpenCodeFixtureIds,
  importOpenCodeFixtureSessions,
  type OpenCodeFixtureSession,
  type OpenCodeFixtureReadback,
} from "@claxedo/harness/opencode-sdk/fixtures"

export function allowWorkspaceRuntimeManagementAuth(subject = "test"): WorkspaceRuntimeManagementAuth {
  return {
    async authorize() {
      return { ok: true, subject, scopes: ["runtime.config.apply"] }
    },
  }
}
