export type ControlPlaneCredentials = {
  listCredentials: () => Promise<unknown[]>
  getCredentialByProvider: (providerId: string) => Promise<unknown | undefined>
  getCredential?: (id: string) => Promise<unknown | undefined>
  resolveCredentialSecret?: (providerId: string) => Promise<string | null>
  resolveCredentialSecretById?: (id: string) => Promise<string | null>
  putCredential: (input: {
    provider_id: string
    kind: "sandbox_driver" | "agent_provider" | "mcp_server" | "oauth_token" | string
    source: "managed" | "local" | "env" | string
  }) => Promise<{
    id: string
    provider_id: string
    kind: string
    source: string
    secure_ref: string
    status: "available" | "expired" | "revoked" | "error"
    created_at: number
    updated_at: number
  }>
  deleteCredential: (id: string) => Promise<boolean>
  deleteCredentialsByProvider: (providerId: string) => Promise<number>
  updateCredentialStatus: (id: string, status: string, error?: string) => Promise<void>
  updateCredentialHealth?: (
    id: string,
    health: "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired",
    validatedAt: number,
  ) => Promise<void>
  syncLocalCredentials: (providerIds?: string[]) => Promise<{
    synced: string[]
    existing: string[]
    missing: string[]
    failed: Array<{ provider_id: string; error: string }>
  }>
}

export type RelayRole = "owner" | "admin" | "editor" | "viewer"

export type RuntimeAccessTokenSigner = (input: {
  subject: string
  orgId: string
  workspaceId: string
  hostId: string
  role: RelayRole
}) => Promise<{
  runtimeAccessToken: string
  tokenExpiresAt: number
  jti: string
}>

export type HostTunnelTokenSigner = (input: {
  subject: string
  hostId: string
  workspaceIds: string[]
}) => Promise<{
  hostTunnelToken: string
  tokenExpiresAt: number
  jti: string
}>

export type SessionWriteMode = "workspace_replicated" | "central_canonical"

/**
 * Central-persistence ports. The composition constructs them (locally via
 * `createSqliteCentralStore({ mode })`, or from any object implementing the
 * `ProjectionStore` / `DurableSessionLog` contracts) and passes them IN —
 * the generic services never build storage themselves.
 */
export type CentralStorePorts = {
  projectionStore: unknown
  durableSessionLog: unknown
}

/** Hosted compositions must also expose the session write mode for validation. */
export type HostedCentralStorePorts = CentralStorePorts & {
  sessionWriteMode: () => SessionWriteMode
}

export type HostedControlPlaneServicesOptions = {
  /** ControlPlaneAuthAdapter with signed auth enabled (fails closed otherwise). */
  auth: unknown
  credentials: ControlPlaneCredentials
  extensionPolicy: unknown
  relay: {
    relayUrl: string
    resolverToken: string
    runtimeAccessTokenSigner: RuntimeAccessTokenSigner
    hostTunnelTokenSigner: HostTunnelTokenSigner
  }
  sandbox: {
    defaultDriver: "daytona" | "modal" | "vercel" | "cloudflare" | "docker"
  }
  telemetry: {
    capture: (distinctId: string, event: string, properties?: Record<string, unknown>) => void
  }
  /** WorkspaceAuthority implementation; always injected by the composition site. */
  authority: unknown
}

export type ClaxedoClientOptions = {
  serverUrl: string
  token?: string
}

export type ClaxedoRequestOptions = {
  headers?: HeadersInit
}

export function createClaxedoClient(options: ClaxedoClientOptions): {
  health: () => Promise<unknown>
  listWorkspaces: (access?: "cloud" | "user-hosted") => Promise<unknown>
  resolveWorkspace: (input: { directory: string; create?: boolean }) => Promise<unknown>
  readFile: (input: { directory: string; path: string }) => Promise<unknown>
  createSession: (input: { directory: string; title: string }, requestOptions?: ClaxedoRequestOptions) => Promise<unknown>
  readSessionMessages: (input: { directory: string; sessionId: string }) => Promise<unknown>
  agentExtensions: {
    catalog: () => Promise<unknown>
    list: (input: { directory: string }) => Promise<unknown>
    install: (input: { directory: string; source: string; id: string; targets: string[] }) => Promise<unknown>
    disable: (input: { directory: string; id: string }) => Promise<unknown>
    enable: (input: { directory: string; id: string }) => Promise<unknown>
    remove: (input: { directory: string; id: string }) => Promise<unknown>
  }
}

export function startServer(port?: number, opencodeUrl?: string, opencodePassword?: string | null): unknown
export function betterAuthAdapter(input: {
  issuer: string
  audience?: string
  jwksUrl?: string
  verifier: (token: string) => Promise<{
    subject?: string
    userId?: string
    user?: { id?: string }
    session?: { id?: string }
    tokenIdentifier?: string
    issuer?: string
    audience?: string | string[]
    orgId?: string
    org_id?: string
    organizationId?: string
  } | null | undefined>
}): unknown
export function createControlPlaneServices(input: CentralStorePorts, options?: {
  authority?: unknown | null
  auth?: unknown
  credentials?: ControlPlaneCredentials
  extensionPolicy?: unknown
  relay?: unknown
  sandbox?: unknown
  telemetry?: unknown
  localExecution?: { enabled: boolean }
  defaultHomeRegion?: string
}): unknown
export function createHostedControlPlaneServices(input: HostedCentralStorePorts, options: HostedControlPlaneServicesOptions): unknown
export function createApp(services: unknown, options?: { onOpencodeAccess?: () => void }): {
  app: { fetch: (request: Request) => Response | Promise<Response> }
  injectWebSocket: (server: unknown) => void
}
export function startUserHostedWorkspaceTunnel(input: {
  workspaceId: string
  hostId: string
  relayUrl: string
  hostTunnelToken: string
}): Promise<{ url?: string; reused: boolean }>
export function stopUserHostedWorkspaceTunnel(input: {
  workspaceId: string
  hostId: string
}): boolean
