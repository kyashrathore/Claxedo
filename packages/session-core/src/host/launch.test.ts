import { expect, test } from "bun:test"
import type { ProviderDirect } from "@claxedo/agent-runtime-contract"
import { sessionCredentials, type LaunchComposer } from "./launch"

const plan: ProviderDirect = { delivery: "direct", baseUrl: "https://chatgpt.com", apiPath: "/backend-api/codex", secret: "plan-access",
  authKind: "subscription", account: { credentialId: "plan-1", providerId: "codex-app-server" } }

const composer: LaunchComposer = {
  workspaceId: "w1",
  projection: () => ({ generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }),
  credentials: () => ({ placement: "cloud", machineOwnerUserId: "member", canUseOwnLogin: false, leaseGeneration: "l1",
    accounts: { member: {} }, direct: { member: { "codex-app-server": plan } } }),
}

function delivered(harness: { id: string; access: "native" | "connection" }) {
  return sessionCredentials(composer, { owner: { kind: "person", userId: "member" }, config: { harness } }).direct
}

test("an OpenCode session is handed its owner's ChatGPT plan as the token, as Codex and Pi sessions are", () => {
  expect(delivered({ id: "opencode", access: "native" })).toEqual({ "codex-app-server": plan })
  expect(delivered({ id: "codex", access: "native" })).toEqual({ "codex-app-server": plan })
  expect(delivered({ id: "pi", access: "native" })).toEqual({ "codex-app-server": plan })
  expect(delivered({ id: "opencode", access: "connection" })).toBeUndefined()
})
