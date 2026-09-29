import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { PiRpc } from "../../../../harness/src/transports/pi-rpc/rpc"
import { piRuntime, resolvePiExecutable } from "../../../../workspace-runtime/src/host/executables/pi"
import { createSpawnService } from "../../../../workspace-runtime/src/spawn-service"
import { clearOpaqueTimer, stringRecord } from "@claxedo/helpers"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import {
  disposeHydratedSessionDocuments,
  hydrateSessionDocument,
  hydratedSessionDocumentPaths,
  syncHydratedSessionDocuments,
} from "@claxedo/server-core/documents/session-hydration"
import { asRecord, numberField } from "@claxedo/server-core/platform/json/index"

const CONTROL_REQUEST_MS = 30_000
const clock = { now: () => Date.now(), setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms), clearTimeout: clearOpaqueTimer }
const piBinary = resolvePiExecutable()

describe("real workspace-runtime document round-trip", () => {
  test.skipIf(piBinary === undefined)(
    "executes the submitted bash command, syncs exact bytes, and disposes the hydrated copy",
    async () => {
      const binary = piBinary!
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-session-native-pi-"))
      const sessionId = `session-${randomUUID()}`
      const before = "before native Pi edit\n"
      const after = "after native Pi edit\n"
      let canonical = before
      let rpc: PiRpc | undefined
      try {
        const hydratedPath = await hydrateSessionDocument({
          sessionId,
          workspaceRoot: root,
          documentId: "document-session-roundtrip",
          displayName: "Session Roundtrip",
          markdown: before,
          baseVersion: "version-1",
          sync: async (markdown) => {
            canonical = markdown
            return "version-2"
          },
        })
        const args = ["--mode", "rpc", "--no-session"]
        const command = /\.[cm]?js$/.test(binary) ? { file: piRuntime(), args: [binary, ...args] } : { file: binary, args }
        const spawn = createSpawnService(volatileLaunchOwnership())
        const owned = await spawn(
          { ...command, cwd: root, env: { ...stringRecord(process.env), PI_CODING_AGENT_DIR: path.join(root, "pi-agent") } },
          { role: "probe", label: "Pi RPC document round-trip", signal: new AbortController().signal },
        )
        rpc = new PiRpc(owned, clock, (event) => console.error(event.diagnostic.message))
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
        const result = asRecord(await rpc.request("bash", { command: `printf %s ${quote(after)} > ${quote(hydratedPath)}` }, CONTROL_REQUEST_MS))
        await syncHydratedSessionDocuments(sessionId)

        expect(numberField(result, "exitCode")).toBe(0)
        expect(canonical).toBe(after)
        expect(hydratedSessionDocumentPaths(sessionId)).toHaveLength(1)

        await disposeHydratedSessionDocuments(sessionId)
        expect(hydratedSessionDocumentPaths(sessionId)).toHaveLength(0)
        await expect(fs.stat(hydratedPath)).rejects.toThrow()
      } finally {
        // Awaited: the temp root is removed below, and removing it under a Pi
        // process nobody established had stopped is what the retirement answers.
        if (rpc) await rpc.retire({ at: Date.now() + CONTROL_REQUEST_MS, signal: new AbortController().signal })
        await disposeHydratedSessionDocuments(sessionId)
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
  )
})
