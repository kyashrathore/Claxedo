import { DocumentsRoutes } from "@claxedo/server-core/documents/routes/index"
import {
  createLocalDocumentsBackend,
  type LocalDocumentsBackendDependencies,
} from "@claxedo/server-core/documents/backends/local/backend"
import { setDocumentChangedSink } from "@claxedo/server-core/documents/backend"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { sessionMeta } from "@claxedo/server-core/session/meta/index"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { controlBus } from "@claxedo/server-core/platform/runtime/lib/bus"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { runGit } from "@claxedo/workspace-runtime/host"
import type { ControlPlaneAuthConfig, ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"

const log = Log.create({ service: "local-documents" })

/**
 * Document git runs in a checkout the daemon merely opened, and that checkout
 * decides what git executes: a `core.fsmonitor` or a clean filter runs during
 * `status` and `add`, so `commit-tree` bypassing commit hooks is not the whole
 * exposure. `runGit` is the reviewed launch owner for git children — the
 * `buildSafeEnv` allowlist, credential prompting off, bounded output — and it
 * admits only git's own operational variables from here, so the commit's
 * scratch index reaches git and the daemon's tokens do not.
 */
export const documentGit: LocalDocumentsBackendDependencies["runGit"] = async (args, directory, options) =>
  (
    await runGit([...args], directory, {
      ...(options?.env ? { env: options.env } : {}),
      ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.maxBufferBytes ? { maxBuffer: options.maxBufferBytes } : {}),
    })
  ).trim()

export function localDocumentsRoutes(auth: {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  authority?: LocalDocumentsBackendDependencies["sessionAuthority"]
}) {
  const backend = createLocalDocumentsBackend({
    resolveWorkspace,
    sessionMeta,
    sessionAuthority: auth.authority,
    dataDir,
    reportError: (error) => log.error("Document operation failed", { error }),
    runGit: documentGit,
  })
  setDocumentChangedSink((event) => controlBus.publish(event))
  return DocumentsRoutes({ backend, authConfig: auth.authConfig, verifier: auth.verifier })
}
