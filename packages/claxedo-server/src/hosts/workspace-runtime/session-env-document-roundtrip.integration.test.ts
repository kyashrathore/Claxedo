import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { ownedExecutionEnv } from "../../../../harness/src/transports/pi-durable/shell"
import { createSpawnService } from "../../../../workspace-runtime/src/spawn-service"
import { clearOpaqueTimer, stringRecord } from "@claxedo/helpers"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import {
  disposeHydratedSessionDocuments,
  hydrateSessionDocument,
  hydratedSessionDocumentPaths,
  syncHydratedSessionDocuments,
} from "@claxedo/server-core/documents/session-hydration"

const clock = { now: () => Date.now(), setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms), clearTimeout: clearOpaqueTimer }
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const context = { abortSignal: undefined, value: () => undefined, toString: () => "document round-trip" }

describe("real workspace-runtime document round-trip", () => {
  test(
    "Pi's owned shell executes the submitted bash command, syncs exact bytes, and disposes the hydrated copy",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-session-native-pi-"))
      const sessionId = `session-${randomUUID()}`
      const before = "before native Pi edit\n"
      const after = "after native Pi edit\n"
      let canonical = before
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
        const spawn = createSpawnService(volatileLaunchOwnership())
        const services = { spawn, clock, log, recordHomeUse: async () => {}, firstPartyMcp: () => undefined, healthChanged: () => {}, patternEvaluator: async () => {} }
        const env = ownedExecutionEnv({ sessionId, services, env: stringRecord(process.env), live: new Set() }, root)
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
        const result = await env.exec(`printf %s ${quote(after)} > ${quote(hydratedPath)}`, undefined, context)
        await syncHydratedSessionDocuments(sessionId)

        expect(result).toEqual({ ok: true, value: { exitCode: 0 } })
        expect(canonical).toBe(after)
        expect(hydratedSessionDocumentPaths(sessionId)).toHaveLength(1)

        await disposeHydratedSessionDocuments(sessionId)
        expect(hydratedSessionDocumentPaths(sessionId)).toHaveLength(0)
        await expect(fs.stat(hydratedPath)).rejects.toThrow()
      } finally {
        await disposeHydratedSessionDocuments(sessionId)
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
  )
})
