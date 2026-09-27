import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PiRpc } from "../../../harness/src/transports/pi-rpc/rpc"
import { piRuntime, requirePiExecutable } from "../../../workspace-runtime/src/host/executables/pi"
import { createSpawnService } from "../../../workspace-runtime/src/spawn-service"
import { clearOpaqueTimer, stringRecord } from "@claxedo/helpers"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import { disposeHydratedSessionDocuments, syncHydratedSessionDocuments, hydrateSessionDocument, hydratedSessionDocumentPaths } from "@claxedo/server-core/documents/session-hydration"
import { asRecord, numberField } from "@claxedo/server-core/platform/json/index"

const CONTROL_REQUEST_MS = 30_000
const clock = { now: () => Date.now(), setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms), clearTimeout: clearOpaqueTimer }

/** Real native Pi shell execution against the document hydration owner. No model credential is needed. */
export async function runDocumentsSessionRoundtripSmoke() {
  const binary = requirePiExecutable(process.env)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-session-native-pi-"))
  const sessionId = `session-${randomUUID()}`
  const before = "before native Pi edit\n"
  const after = "after native Pi edit\n"
  let canonical = before
  let rpc: PiRpc | undefined
  try {
    const hydratedPath = await hydrateSessionDocument({ sessionId, workspaceRoot: root, documentId: "document-session-smoke", displayName: "Session Smoke", markdown: before, baseVersion: "version-1", sync: async markdown => { canonical = markdown; return "version-2" } })
    const args = ["--mode", "rpc", "--no-session"]
    const command = /\.[cm]?js$/.test(binary) ? { file: piRuntime(), args: [binary, ...args] } : { file: binary, args }
    const spawn = createSpawnService(volatileLaunchOwnership())
    const owned = await spawn(
      { ...command, cwd: root, env: { ...stringRecord(process.env), PI_CODING_AGENT_DIR: path.join(root, "pi-agent") } },
      { role: "probe", label: "Pi RPC smoke", signal: new AbortController().signal },
    )
    rpc = new PiRpc(owned, clock, (event) => console.error(event.diagnostic.message))
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    const result = asRecord(await rpc.request("bash", { command: `printf %s ${quote(after)} > ${quote(hydratedPath)}` }, CONTROL_REQUEST_MS))
    await syncHydratedSessionDocuments(sessionId)
    const exitCode = numberField(result, "exitCode")
    if (exitCode !== 0) throw new Error(`Native Pi shell exited ${exitCode ?? "without a status"}`)
    if (canonical !== after) throw new Error("Native Pi edit did not sync exact canonical bytes")
    const hydratedDocuments = hydratedSessionDocumentPaths(sessionId).length
    await disposeHydratedSessionDocuments(sessionId)
    const disposed = hydratedSessionDocumentPaths(sessionId).length === 0 && !await fs.stat(hydratedPath).then(() => true, () => false)
    if (hydratedDocuments !== 1 || !disposed) throw new Error("Session document lifecycle was not contained")
    return { sessionId, exitCode, beforeSha256: sha256(before), afterSha256: sha256(canonical), exactBytes: true, hydratedDocuments, disposed }
  } finally {
    // Awaited: the temp root is removed below, and removing it under a Pi
    // process nobody established had stopped is what the retirement answers.
    if (rpc) await rpc.retire({ at: Date.now() + CONTROL_REQUEST_MS, signal: new AbortController().signal })
    await disposeHydratedSessionDocuments(sessionId)
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
if (import.meta.main) console.log(`DOCUMENTS_SESSION_ROUNDTRIP ${JSON.stringify(await runDocumentsSessionRoundtripSmoke())}`)
