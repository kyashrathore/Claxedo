export interface NormalizedIssue {
  id: string;
  title: string;
  description: string;
  status: "open" | "closed" | "in_progress";
  provider_url: string;
}

interface LinearClient {
  getIssue(issueId: string): Promise<any>;
  updateIssue(issueId: string, input: Record<string, any>): Promise<void>;
  createComment(issueId: string, body: string): Promise<void>;
  createIssue(teamId: string, input: Record<string, any>): Promise<any>;
}

export class LinearConnector {
  private client: LinearClient;

  constructor(client: LinearClient) {
    this.client = client;
  }

  async hydrateIssue(issueId: string): Promise<NormalizedIssue> {
    const data = await this.client.getIssue(issueId);
    return {
      id: data.id,
      title: data.title,
      description: data.description || "",
      status: this.mapStatus(data.state?.name || ""),
      provider_url: data.url,
    };
  }

  async updateIssue(issueId: string, updates: { title?: string; status?: string; description?: string }): Promise<void> {
    const input: Record<string, any> = {};
    if (updates.title) input.title = updates.title;
    if (updates.description) input.description = updates.description;
    await this.client.updateIssue(issueId, input);
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.client.createComment(issueId, body);
  }

  async createIssue(teamId: string, data: { title: string; description: string }): Promise<NormalizedIssue> {
    const result = await this.client.createIssue(teamId, { title: data.title, description: data.description });
    return {
      id: result.id,
      title: data.title,
      description: data.description,
      status: "open",
      provider_url: result.url,
    };
  }

  private mapStatus(linearState: string): "open" | "closed" | "in_progress" {
    const lower = linearState.toLowerCase();
    if (lower === "done" || lower === "canceled" || lower === "cancelled") return "closed";
    if (lower === "in progress" || lower === "started") return "in_progress";
    return "open";
  }
}
