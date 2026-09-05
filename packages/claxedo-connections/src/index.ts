export * from "./types.js"
export { createIntegrationRegistry, type IntegrationRegistry } from "./registry.js"
export { createConnectionsService, type ConnectionsService, type CapabilityHandle, type ConnectResult, type RepositoryListResult, type TokenResult } from "./service.js"
export { createIntegrationsRoutes, type IntegrationsRouteOptions, type RouteGate } from "./routes.js"
export { createAttempts, type Attempts, type AttemptRouting } from "./attempts.js"
export { createTokenService, ConnectionTokenError, DefinitiveRefreshError } from "./tokens.js"
export { createMemoryCredentialStore, createMemoryConnectionStore } from "./stores/memory.js"
export {
  CONFORMANCE_OWNERS,
  CONNECTION_STORE_CONFORMANCE_SCOPE,
  CONNECTION_STORE_CONFORMANCE_VERSION,
  CREDENTIAL_STORE_CONFORMANCE_SCOPE,
  CREDENTIAL_STORE_CONFORMANCE_VERSION,
  connectionStoreConformance,
  credentialStoreConformance,
  type ConnectionStoreConformanceCase,
  type ConnectionStoreConformanceFactory,
  type CredentialStoreConformanceCase,
  type CredentialStoreConformanceFactory,
} from "./conformance/index.js"
export { notionIntegration } from "./impls/notion.js"
export { atlassianIntegration } from "./impls/atlassian.js"
// Test-support export: the shared `site_url` contract, so a consumer that
// re-validates a stored Atlassian URL can prove its rule matches this one.
// Data only — no runtime behavior, and nothing here is used by the kit itself.
export {
  ATLASSIAN_SITE_URL_VECTORS,
  type AtlassianSiteUrlVector,
} from "./impls/atlassian-site-url-vectors.js"
export { githubIntegration, type GitHubIntegrationOptions } from "./impls/github.js"
export { linearIntegration } from "./impls/linear.js"
export { googleIntegration } from "./impls/google.js"
export type {
  ConnectionWebhookRequest,
  ConnectionWebhookVerifier,
  VerifiedConnectionWebhookSignal,
} from "./webhooks.js"
export {
  createConnectionWebhookVerifier,
  githubConnectionWebhookVerifier,
  jiraConnectionWebhookVerifier,
  linearConnectionWebhookVerifier,
} from "./webhooks.js"
