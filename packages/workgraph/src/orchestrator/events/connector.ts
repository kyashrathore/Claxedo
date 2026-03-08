export interface NormalizedIssue {
  id: string;
  title: string;
  description: string;
  status: "open" | "closed" | "in_progress";
  provider_url: string;
}

export interface ConnectorInterface {
  provider: string;
  hydrateIssue(params: Record<string, any>): Promise<NormalizedIssue>;
  updateIssue(params: Record<string, any>, updates: { title?: string; status?: string; description?: string }): Promise<void>;
  addComment(params: Record<string, any>, comment: string): Promise<void>;
  createIssue(params: Record<string, any>, data: { title: string; description: string }): Promise<NormalizedIssue>;
}
