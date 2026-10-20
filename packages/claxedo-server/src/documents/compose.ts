import { createHostedDocumentsPlugin, type R2BucketBinding } from "@claxedo/documents/hosted"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { HostedServerPlugin } from "@claxedo/server-core/plugins/server-plugin"
import type { D1AccessContext } from "../authority/adapters/d1/access-context"
import { d1DocumentAccess } from "../authority/adapters/d1/document-authority"
import type { HostedControlPlane } from "../authority/hosted-services"
import { createHostedDocumentRuntimeBroker } from "./runtime-broker"

export type HostedDocumentsPluginInput = Readonly<{
  bucket: R2BucketBinding
  plane: HostedControlPlane
  access: D1AccessContext
  authentication: RequestAuthenticationAdapter
  rateLimit: (key: string) => Promise<boolean>
}>

/** The Documents plugin over this deployment's D1 sharing authority and its relay to a session's runtime. */
export function composeHostedDocumentsPlugin(input: HostedDocumentsPluginInput): HostedServerPlugin {
  const { plane } = input
  return createHostedDocumentsPlugin({
    bucket: input.bucket,
    env: plane.env,
    services: plane.services,
    authentication: input.authentication,
    access: (index) => d1DocumentAccess(input.access, index),
    runtime: createHostedDocumentRuntimeBroker(plane.services, plane.env),
    rateLimit: input.rateLimit,
  })
}
