import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PiRpcProcess } from "../../../agent-sdk-runtime/src/harnesses/pi/rpc-process"
import { requirePiExecutable, verifyPiExecutable } from "../../../agent-sdk-runtime/src/harnesses/pi/executable"
import { volatileLaunchOwnership } from "../../../agent-sdk-runtime/src/launch"
import { controlRequestDeadline } from "../../../agent-sdk-runtime/src/harnesses/shared/request-deadline"
import { disposeHydratedSessionDocuments, syncHydratedSessionDocuments, hydrateSessionDocument, hydratedSessionDocumentPaths } from "@claxedo/server-core/documents/session-hydration"
import { asRecord, numberField } from "@claxedo/server-core/platform/json/index"

/** Real native Pi shell execution against the document hydration owner. No model credential is needed. */
export async function runDocumentsSessionRoundtripSmoke() {
  const binary = requirePiExecutable()
  await verifyPiExecutable(binary)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-session-native-pi-"))
  const sessionId = `session-${randomUUID()}`
  const before = "before native Pi edit\n"
  const after = "after native Pi edit\n"
  let canonical = before
  let rpc: PiRpcProcess | undefined
  try {
    const hydratedPath = await hydrateSessionDocument({ sessionId, workspaceRoot: root, documentId: "document-session-smoke", displayName: "Session Smoke", markdown: before, baseVersion: "version-1", sync: async markdown => { canonical = markdown; return "version-2" } })
    rpc = await PiRpcProcess.start({ binary, directory: root, args: ["--mode", "rpc", "--no-session"], env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "pi-agent") }, ownership: volatileLaunchOwnership() })
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    const result = asRecord(await rpc.request("bash", { command: `printf %s ${quote(after)} > ${quote(hydratedPath)}` }, controlRequestDeadline()))
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
    if (rpc) await rpc.dispose()
    await disposeHydratedSessionDocuments(sessionId)
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
if (import.meta.main) console.log(`DOCUMENTS_SESSION_ROUNDTRIP ${JSON.stringify(await runDocumentsSessionRoundtripSmoke())}`)
