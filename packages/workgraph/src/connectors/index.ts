/**
 * Connector factories for the public client. Each returns a ConnectionSpec —
 * a provider name, a ConnectorInterface implementation, and an optional
 * firehose query the client runs on sync().
 */

import type { ConnectorInterface, ProviderParams, ProviderQueryMode } from "./interface"
import { ComposioGitHubExecutor, FetchGitHubExecutor, GitHubConnector, type GitHubProxyExecutor } from "./github/github"
import { createGitHubAdapter } from "./github/adapter"
import { LinearConnector } from "./linear/linear"
import { createLinearAdapter } from "./linear/adapter"
import { JiraConnector } from "./jira/jira"
import { createJiraAdapter } from "./jira/adapter"

export type {
  ConnectorInterface,
  NormalizedIssue,
  ProviderName,
  ProviderParams,
  ProviderPreview,
  ProviderQueryMode,
  IssueUpdate,
} from "./interface"
export { GitHubConnector, ComposioGitHubExecutor, FetchGitHubExecutor } from "./github/github"
export { LinearConnector } from "./linear/linear"
export { JiraConnector } from "./jira/jira"
export { nativeConnector } from "./native"

export interface ConnectionQuery {
  mode: ProviderQueryMode
  params: ProviderParams
}

export interface ConnectionSpec {
  provider: string
  connector: ConnectorInterface
  /** Firehose query executed by sync(). Omit for push/manual-only connections. */
  query?: ConnectionQuery
}

/**
 * GitHub. `query` takes raw GitHub search syntax
 * ("repo:acme/app is:open label:bug"). Three ways to authenticate:
 *
 * - `getToken` (recommended for hosts): a token-supplier seam shaped like
 *   @claxedo/connections' CapabilityHandle. Uses the plain-fetch executor —
 *   the token is resolved per request, so rotation/refresh just works, and
 *   401s are reported back through `reportAuthFailure`.
 * - `token`: static Composio connected-account id (Composio proxy executor).
 * - `executor`: bring your own GitHubProxyExecutor (tests, custom proxies).
 */
export function github(opts: {
  token?: string
  /** Per-request token supplier (CapabilityHandle-shaped, @claxedo/connections). */
  getToken?: () => Promise<string>
  /** Called when GitHub answers 401, so the connections layer can mark the credential broken. */
  reportAuthFailure?: (reason: string) => Promise<void>
  executor?: GitHubProxyExecutor
  query?: string | ConnectionQuery
}): ConnectionSpec {
  const executor = opts.executor
    ?? (opts.getToken
      ? new FetchGitHubExecutor({ getToken: opts.getToken, reportAuthFailure: opts.reportAuthFailure })
      : new ComposioGitHubExecutor(reqToken(opts.token, "github")))
  return {
    provider: "github",
    connector: createGitHubAdapter(new GitHubConnector(executor)),
    query: normalizeQuery(opts.query),
  }
}

/** Linear. Bring a LinearClient (see LinearConnector's client interface). */
// TODO(@claxedo/connections): no Linear integration impl exists in the
// connections framework yet. When one lands, grow a `getToken`/
// `reportAuthFailure` seam here mirroring github() above.
export function linear(opts: {
  client: ConstructorParameters<typeof LinearConnector>[0]
  query?: ConnectionQuery
}): ConnectionSpec {
  return {
    provider: "linear",
    connector: createLinearAdapter(new LinearConnector(opts.client)),
    query: opts.query,
  }
}

/** Jira. Bring a JiraClient (see JiraConnector's client interface). */
export function jira(opts: {
  client: ConstructorParameters<typeof JiraConnector>[0]
  query?: ConnectionQuery
}): ConnectionSpec {
  return {
    provider: "jira",
    connector: createJiraAdapter(new JiraConnector(opts.client)),
    query: opts.query,
  }
}

/** Any custom ConnectorInterface implementation. */
export function custom(spec: ConnectionSpec): ConnectionSpec {
  return spec
}

function normalizeQuery(query?: string | ConnectionQuery): ConnectionQuery | undefined {
  if (!query) return undefined
  if (typeof query === "string") {
    return { mode: "project_or_team", params: { q: query } }
  }
  return query
}

function reqToken(token: string | undefined, provider: string): string {
  if (token?.trim()) return token.trim()
  throw new Error(`${provider} connection needs a token (or a custom executor/client)`)
}
