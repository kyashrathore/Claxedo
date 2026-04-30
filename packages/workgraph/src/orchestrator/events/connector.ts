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
