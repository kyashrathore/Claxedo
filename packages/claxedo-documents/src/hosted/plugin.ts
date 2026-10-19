import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import type { HostedServerPlugin } from "@claxedo/server-core/plugins/server-plugin"
import type { DocumentAccess } from "../host/access"
import type { DocumentsBackend } from "../host/backend"
import { DocumentsRoutes } from "../host/routes"
import { PublicDocumentRoutes } from "../host/routes/public"
import { createHostedDocumentsBackend, type HostedDocumentsRuntime } from "./backend"
import type { R2BucketBinding } from "./r2-object-store.cf"

/** What a hosted deployment implements for Documents from its own owners. */
export type HostedDocumentsPorts = Readonly<{
  bucket: R2BucketBinding
  env: NodeJS.ProcessEnv
  /** Read at request time: the composition may install its authority after this plugin is built. */
  services: { authority?: WorkspaceAuthority }
  authentication: RequestAuthenticationAdapter
  /** Who may read, edit and share a document, decided by the deployment's own authority over its organizations and teams. */
  access: (index: DocumentsBackend["index"]) => DocumentAccess
  /** How a session's runtime is reached to hydrate a document into it and resolve its conflicts. */
  runtime: HostedDocumentsRuntime
  /** The cross-isolate limit a public page read is counted against. */
  rateLimit: (key: string) => Promise<boolean>
}>

/** Hosted Pages over the `CLAXEDO_DOCUMENTS` bucket: the signed `/documents` routes and the public `/p` reads. */
export function createHostedDocumentsPlugin(ports: HostedDocumentsPorts): HostedServerPlugin {
  const backend = createHostedDocumentsBackend(ports.bucket, {
    env: ports.env,
    access: ports.access,
    runtime: ports.runtime,
    resolveSessionWorkspace: async (auth, sessionId) => {
      const authority = requireAuthority(ports.services)
      if (!authority.resolveSession) throw new Error("Session placement resolution is unavailable")
      const resolved = asRecord(await authority.resolveSession(auth, { sessionId }))
      if (typeof resolved?.workspace_id !== "string") throw new Error("Session placement is unavailable")
      return resolved.workspace_id
    },
  })
  return {
    id: "claxedo-documents",
    capability: "documents",
    routeContributions: [
      {
        id: "claxedo-documents",
        path: "/documents",
        routes: DocumentsRoutes({
          backend,
          services: ports.services,
          authentication: ports.authentication,
          env: ports.env,
        }),
      },
      { id: "claxedo-public-documents", path: "/p", routes: PublicDocumentRoutes({ backend, rateLimit: ports.rateLimit }) },
    ],
    mcp: {
      groups: [],
      service: {
        id: "documents",
        grant: async ({ inProcessFetch }) => ({ fetch: inProcessFetch({}), operations: [] }),
      },
    },
  }
}
