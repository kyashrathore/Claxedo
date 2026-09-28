import { expect, test } from "bun:test"
import type { PromptModel } from "@claxedo/agent-runtime-contract"
import type { ConfigPreviewTarget, HarnessSession, HarnessTransport } from "@claxedo/harness/contract"
import type { SessionAttachments } from "./attachments"
import type { AgentRuntimeStore } from "./contracts"
import type { HarnessHandle } from "./transports"
import { createHarnessReads } from "./config-ops"

test("runtime-owned previews read the current saved model on every request", async () => {
  let model: PromptModel | undefined = { providerID: "proof", modelID: "first" }
  const calls: ConfigPreviewTarget[] = []
  const handle = { transport: {
    capabilities: async () => ({ configOwner: "runtime" }),
    config: { options: async (target: ConfigPreviewTarget) => { calls.push(target); return { options: [] } } },
  } as unknown as HarnessTransport } as HarnessHandle
  const session: HarnessSession = { directory: "/tmp", locality: "local", binding: {
    sessionId: "session", workspaceId: "workspace", upstreamSessionId: "upstream", directory: "/tmp", connectionId: "opencode",
  } }
  const reads = createHarnessReads({
    store: { getSessionConfig: () => ({ harness: { id: "opencode", access: "native" }, model }) } as unknown as AgentRuntimeStore,
    attachments: { for: async () => ({ handle, session }) } as unknown as SessionAttachments,
    transports: { forHarness: async () => handle, composed: () => [handle], onRetire: () => () => {} },
    savedCommands: () => [],
    launch: { workspaceId: "workspace", credentials: () => ({ providers: {}, secrets: {}, leaseGeneration: "one" }),
      projection: () => ({ generation: "one", mcpServers: [], pluginRoots: [], notApplied: [] }) },
  })
  await reads.configOptions({ sessionId: "session" })
  expect(calls.at(-1)).toEqual({ session, model })
  model = { providerID: "proof", modelID: "second" }
  await reads.configOptions({ sessionId: "session" })
  expect(calls.at(-1)).toEqual({ session, model })
  await reads.configOptions({ sessionId: "session" }, "preview")
  expect(calls.at(-1)).toEqual({ session, model: { providerID: "proof", modelID: "preview" } })
  model = undefined
  await reads.configOptions({ sessionId: "session" })
  expect(calls.at(-1)).toEqual({ session })
})
