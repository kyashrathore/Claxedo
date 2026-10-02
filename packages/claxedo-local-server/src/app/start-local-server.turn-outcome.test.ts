import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { createSqliteUsageLedger } from "@claxedo/server-core/usage/adapters/sqlite-usage-ledger"
import type * as EmbeddedRuntime from "../deployments/local/embedded-workspace-runtime"
import { startLocalServer, type LocalServer } from "./start-local-server"
import type { LocalAppOptions } from "./local-app"
import { testDaemon } from "./test-support/daemon"
import { buildAssistantMessage, messageUpdated, sessionUsage } from "@claxedo/session-core"

type RuntimeHooks = Parameters<typeof EmbeddedRuntime.configureEmbeddedWorkspaceRuntime>[0]

const runtime = vi.hoisted(() => ({ hooks: undefined as RuntimeHooks | undefined }))

vi.mock("../deployments/local/embedded-workspace-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddedRuntime>()
  return {
    ...actual,
    configureEmbeddedWorkspaceRuntime: (input: RuntimeHooks) => {
      runtime.hooks = input
      actual.configureEmbeddedWorkspaceRuntime(input)
    },
    readEmbeddedWorkspaceSessionConfig: () =>
      ({ harness: { id: "codex", access: "native" }, model: { providerID: "openai", modelID: "gpt-5.4" } }) as ReturnType<
        typeof actual.readEmbeddedWorkspaceSessionConfig
      >,
  }
})

let dataDir: string
let previous: string | undefined
let server: LocalServer | undefined

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-turn-outcome-"))
  previous = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  ClaxedoDB.close()
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
  rmSync(dataDir, { recursive: true, force: true })
})

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("could not allocate a port"))
        return
      }
      probe.close(() => resolve(address.port))
    })
    probe.on("error", reject)
  })
}

function services() {
  return {
    auth: { config: {} },
    credentials: {
      listCredentials: async () => [],
      getCredentialByProvider: async () => undefined,
      putCredential: async () => ({ id: "cred_1" }),
      deleteCredential: async () => true,
      deleteCredentialsByProvider: async () => 0,
      updateCredentialStatus: async () => {},
      syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
    },
    localExecution: { enabled: true },
    telemetry: { capture: vi.fn() },
    projectionStore: {
      put_session_meta: vi.fn(async () => {}),
      delete_session_meta: vi.fn(async () => {}),
      sync_session_meta: vi.fn(async () => {}),
      session_meta: vi.fn(async () => ({ sessionRef: "workspace:ws_local:session:ses_cancelled", workspaceID: "ws_local" })),
    },
    relay: {},
    sandbox: {},
    durableSessionLog: {},
  } as unknown as LocalAppOptions["services"]
}

test("a turn the user cancels on the desktop settles as stopped with its usage, not as an error", async () => {
  server = startLocalServer({
    port: await freePort(),
    daemon: testDaemon().daemon,
    services: services(),
    corsOrigin: (origin) => origin,
  })
  const hooks = runtime.hooks
  if (!hooks?.onSessionMetaEvent || !hooks.onTurnOutcome) throw new Error("the desktop composes no runtime usage hooks")

  const sessionID = "ses_cancelled"
  const messageID = "msg_cancelled"
  for (const payload of [
    messageUpdated(buildAssistantMessage({
      id: messageID,
      sessionID,
      parentID: "msg_user_1",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.4" },
      directory: "/workspace",
      created: 1_000,
    })),
    sessionUsage({
      sessionID,
      messageID,
      contextSize: 200_000,
      contextUsed: 1_500,
      observation: {
        kind: "cumulative",
        providerObservationId: "obs_cancelled",
        observedAt: Date.now(),
        tokens: { input: 1_200, output: 300, reasoning: 40, cache: { read: 500, write: 0 } },
      },
    }),
  ]) hooks.onSessionMetaEvent({ directory: "/workspace", payload })
  hooks.onTurnOutcome({
    sessionId: sessionID,
    assistantMessageId: messageID,
    outcome: { status: "cancelled", completedAt: Date.now() },
  })

  const ledger = createSqliteUsageLedger()
  await vi.waitFor(async () => {
    expect((await ledger.current({ sessionId: sessionID })).at(-1)).toMatchObject({
      messageId: messageID,
      settlement: "partial",
      status: "stopped",
      tokens: { input: 1_200, output: 300 },
    })
  }, { timeout: 10_000 })
}, 30_000)
