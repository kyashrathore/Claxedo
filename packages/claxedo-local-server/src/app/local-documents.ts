import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { DocumentsRoutes } from "@claxedo/server-core/documents/routes/index"
import { createLocalDocumentsBackend } from "@claxedo/server-core/documents/backends/local/backend"
import { setDocumentChangedSink } from "@claxedo/server-core/documents/backend"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { sessionMeta } from "@claxedo/server-core/session/meta/index"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { controlBus } from "@claxedo/server-core/platform/runtime/lib/bus"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { ControlPlaneAuthConfig, ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"

const execFileAsync = promisify(execFile)
const log = Log.create({ service: "local-documents" })

export function localDocumentsRoutes(auth: { authConfig?: ControlPlaneAuthConfig; verifier?: ControlPlaneTokenVerifier }) {
  const backend = createLocalDocumentsBackend({
    resolveWorkspace,
    sessionMeta,
    dataDir,
    reportError: (error) => log.error("Document operation failed", { error }),
    runGit: async (args, directory, options) => (await execFileAsync("git", [...args], {
      cwd: directory,
      ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
      ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
      ...(options?.maxBufferBytes ? { maxBuffer: options.maxBufferBytes } : {}),
    })).stdout.trim(),
  })
  setDocumentChangedSink((event) => controlBus.publish(event))
  return DocumentsRoutes({ backend, ...auth })
}
