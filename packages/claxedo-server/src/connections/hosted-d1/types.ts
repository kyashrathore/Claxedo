import type { IntegrationDeclaration, IntegrationImpl } from "@claxedo/connections"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"

/**
 * Feature-owned integrations resolved from the authenticated durable owner
 * context. Agent Plugins contributes retained MCP servers through this seam;
 * the hosted Connections setup owns every row, attempt, and credential.
 */
export type HostedDynamicConnectionIntegrations = (context: {
  ownerUserId: string
  orgId: string
  integrationId?: string
  auth?: SignedControlPlaneAuth
  attemptContext?: Readonly<Record<string, string>>
  /** Public canonical fields from an existing row, used to rebuild refresh behavior at call time. */
  connectionFields?: Readonly<Record<string, string>>
  /** Present for authenticated management requests; callbacks reconstruct from the frozen attempt instead. */
  request?: Request
}) => Promise<ReadonlyArray<{ decl: IntegrationDeclaration; impl: IntegrationImpl }>>
