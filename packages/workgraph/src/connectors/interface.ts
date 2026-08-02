export interface NormalizedIssue {
  id: string;
  title: string;
  description: string;
  status: "open" | "closed" | "in_progress";
  provider_url: string;
  external_key?: string;
  parent_external_key?: string | null;
  child_external_keys?: string[];
  aggregate_only?: boolean;
}

export type ProviderName = "github" | "linear"
export type ProviderQueryMode =
  | "single_item"
  | "assigned_to_me"
  | "updated_since"
  | "project_or_team"

export type ProviderParams = Record<string, unknown>

export type IssueUpdate = {
  title?: string
  status?: string
  description?: string
}

export interface ProviderPreview extends NormalizedIssue {
  provider: ProviderName
  provider_meta: ProviderParams
}

/**
 * Q is the union of query strings the connector implementation supports.
 * Each connector defines its own query type based on the provider's actual API.
 */
export interface ConnectorInterface<Q extends string = string, P extends ProviderParams = ProviderParams> {
  provider: string;
  validate?(): Promise<{ label?: string }>;
  queryIssues?(query: Q, params: P): Promise<ProviderPreview[]>;
  hydrateIssue(params: P): Promise<NormalizedIssue>;
  updateIssue(params: P, updates: IssueUpdate): Promise<void>;
  addComment(params: P, comment: string): Promise<void>;
  createIssue(params: P, data: { title: string; description: string }): Promise<NormalizedIssue>;
}

/** Public, normalized issue data returned by the v2 personal intake path. */
export type SourceIssue = Readonly<{
  externalId: string
  externalKey?: string
  externalUrl?: string
  title: string
  body: string
  status: string
  updatedAt: number
  revision?: string
}>

export type SourceIssueAuthorization = Readonly<{
  token: string
  tokenType: "bearer" | "basic"
  fields?: Readonly<Record<string, string>>
}>

export class SourceIssueConfigurationError extends Error {
  readonly code = "source_issue_configuration_required"
  readonly retryable = false

  constructor(
    provider: string,
    readonly field: string,
  ) {
    super(`${provider} source requests require ${field}`)
    this.name = "SourceIssueConfigurationError"
  }
}

export class SourceIssueUnauthorizedError extends Error {
  readonly code = "source_issue_provider_unauthorized"
  readonly status = 401

  constructor(provider: string) {
    super(`${provider} rejected the live connection authorization`)
    this.name = "SourceIssueUnauthorizedError"
  }
}

export class SourceIssueResponseError extends Error {
  readonly retryable = true

  constructor(provider: string) {
    super(`${provider} returned an invalid source issue response`)
    this.name = "SourceIssueResponseError"
  }
}

export class SourceIssueProviderError extends Error {
  readonly code = "source_issue_provider_error"
  readonly retryable: boolean

  constructor(
    provider: string,
    readonly status: number,
  ) {
    super(`${provider} source request failed (${status})`)
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError("Source issue provider status must be an HTTP failure status")
    }
    this.name = "SourceIssueProviderError"
    this.retryable = status === 429 || status >= 500
  }
}

export class SourceIssueTransportError extends Error {
  readonly code = "source_issue_transport_unavailable"
  readonly retryable = true

  constructor(provider: string) {
    super(`${provider} source transport is unavailable`)
    this.name = "SourceIssueTransportError"
  }
}

/**
 * Provider code receives authorization only for the duration of one live
 * connector call. Source views and intake records contain no credential data.
 */
export type SourceIssueConnector = Readonly<{
  provider: "github" | "linear" | "jira"
  list(
    authorization: SourceIssueAuthorization,
    input: Readonly<{ providerUserId: string; filters: Readonly<Record<string, string>>; cursor?: string }>,
  ): Promise<Readonly<{ issues: readonly SourceIssue[]; cursor?: string }>>
  comment(
    authorization: SourceIssueAuthorization,
    input: Readonly<{ externalId: string; body: string; idempotencyKey: string }>,
  ): Promise<void>
  update(
    authorization: SourceIssueAuthorization,
    input: Readonly<{ externalId: string; status?: string; body?: string; idempotencyKey: string }>,
  ): Promise<void>
}>
