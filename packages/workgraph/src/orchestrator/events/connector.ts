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

export interface ProviderPreview extends NormalizedIssue {
  provider: ProviderName
  provider_meta: Record<string, any>
}

/**
 * Q is the union of query strings the connector implementation supports.
 * Each connector defines its own query type based on the provider's actual API.
 */
export interface ConnectorInterface<Q extends string = string> {
  provider: string;
  validate?(): Promise<{ label?: string }>;
  queryIssues?(query: Q, params: Record<string, any>): Promise<ProviderPreview[]>;
  hydrateIssue(params: Record<string, any>): Promise<NormalizedIssue>;
  updateIssue(params: Record<string, any>, updates: { title?: string; status?: string; description?: string }): Promise<void>;
  addComment(params: Record<string, any>, comment: string): Promise<void>;
  createIssue(params: Record<string, any>, data: { title: string; description: string }): Promise<NormalizedIssue>;
}
