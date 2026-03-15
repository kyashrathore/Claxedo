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

export interface ProviderPreview extends NormalizedIssue {
  provider: ProviderName
  provider_meta: Record<string, any>
}

export interface ConnectorInterface {
  provider: string;
  validate?(): Promise<{ label?: string }>;
  queryIssues?(mode: ProviderQueryMode, params: Record<string, any>): Promise<ProviderPreview[]>;
  hydrateIssue(params: Record<string, any>): Promise<NormalizedIssue>;
  updateIssue(params: Record<string, any>, updates: { title?: string; status?: string; description?: string }): Promise<void>;
  addComment(params: Record<string, any>, comment: string): Promise<void>;
  createIssue(params: Record<string, any>, data: { title: string; description: string }): Promise<NormalizedIssue>;
}
