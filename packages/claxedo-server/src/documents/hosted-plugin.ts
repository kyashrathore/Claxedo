import { DocumentsRoutes } from "@claxedo/server-core/documents/routes/index"
import { PublicDocumentRoutes } from "@claxedo/server-core/documents/routes/public"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import type { HostedServerPlugin } from "@claxedo/server-core/plugins/server-plugin"
import type { D1AccessContext } from "../authority/adapters/d1/access-context"
import { d1DocumentAccess } from "../authority/adapters/d1/document-authority"
import type { HostedControlPlane } from "../authority/hosted-services"
import { createHostedDocumentsBackend } from "./backends/hosted/backend"
import type { R2BucketBinding } from "./backends/hosted/r2-object-store.cf"
import { createHostedDocumentRuntimeBroker } from "./backends/hosted/runtime-broker"

export type HostedDocumentsPluginInput = Readonly<{
  bucket: R2BucketBinding
  plane: HostedControlPlane
  access: D1AccessContext
  authentication: RequestAuthenticationAdapter
  /** The cross-isolate limit a public page read is counted against. */
  rateLimit: (key: string) => Promise<boolean>
}>

/** Hosted Pages over the `CLAXEDO_DOCUMENTS` bucket: the signed `/documents` routes and the public `/p` reads. */
export function createHostedDocumentsPlugin(input: HostedDocumentsPluginInput): HostedServerPlugin {
  const { plane } = input
  const backend = createHostedDocumentsBackend(input.bucket, {
    env: plane.env,
    access: (index) => d1DocumentAccess(input.access, index),
    runtime: createHostedDocumentRuntimeBroker(plane.services, plane.env),
    resolveSessionWorkspace: async (auth, sessionId) => {
      const authority = requireAuthority(plane.services)
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
          services: plane.services,
          authentication: input.authentication,
          env: plane.env,
        }),
      },
      { id: "claxedo-public-documents", path: "/p", routes: PublicDocumentRoutes({ backend, rateLimit: input.rateLimit }) },
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
