import { DocumentsRoutes } from "../host/routes"
import {
  createLocalDocumentsBackend,
  type LocalDocumentsBackendDependencies,
} from "../host/backends/local/backend"
import { setDocumentChangedSink } from "../host/backend"
import { DOCUMENTS_MCP_TOOL_GROUP } from "../mcp"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { sessionMeta } from "@claxedo/server-core/session/meta/index"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { controlBus } from "@claxedo/server-core/platform/runtime/lib/bus"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { runGit } from "@claxedo/workspace-runtime/host"
import type { LocalServerPlugin } from "@claxedo/server-core/plugins/server-plugin"

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

/**
 * The repository and managed document backend for this machine's own
 * workspaces, mounted at `/documents`. Its routes verify a signed caller with
 * the host's own authentication, which the host hands over at mount.
 */
export function createLocalDocumentsPlugin(): LocalServerPlugin {
  return {
    id: "claxedo-documents",
    capability: "documents",
    routeContributions: (host) => {
      const backend = createLocalDocumentsBackend({
        resolveWorkspace,
        sessionMeta,
        dataDir,
        reportError: (error) => log.error("Document operation failed", { error }),
        runGit: documentGit,
      })
      setDocumentChangedSink((event) => controlBus.publish(event))
      return [{
        id: "claxedo-documents",
        path: "/documents",
        routes: DocumentsRoutes({ backend, authConfig: host.authConfig, verifier: host.verifier }),
      }]
    },
    mcp: {
      groups: [DOCUMENTS_MCP_TOOL_GROUP],
      service: {
        id: "documents",
        grant: async ({ workspaceId, inProcessFetch }) => ({
          fetch: inProcessFetch(workspaceId ? { "x-workspace-id": workspaceId } : {}),
          operations: [],
        }),
      },
    },
  }
}
