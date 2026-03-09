export interface NormalizedIssue {
  id: string;
  title: string;
  description: string;
  status: "open" | "closed" | "in_progress";
  provider_url: string;
}

interface JiraClient {
  getIssue(issueKey: string): Promise<any>;
  updateIssue(issueKey: string, fields: Record<string, any>): Promise<void>;
  addComment(issueKey: string, body: string): Promise<void>;
  createIssue(projectKey: string, fields: Record<string, any>): Promise<any>;
}

export class JiraConnector {
  private client: JiraClient;

  constructor(client: JiraClient) {
    this.client = client;
  }

  async hydrateIssue(issueKey: string): Promise<NormalizedIssue> {
    const data = await this.client.getIssue(issueKey);
    return {
      id: data.key,
      title: data.fields.summary,
      description: data.fields.description || "",
      status: this.mapStatus(data.fields.status.name),
      provider_url: data.self,
    };
  }

  async updateIssue(issueKey: string, updates: { title?: string; status?: string; description?: string }): Promise<void> {
    const fields: Record<string, any> = {};
    if (updates.title) fields.summary = updates.title;
    if (updates.description) fields.description = updates.description;
    await this.client.updateIssue(issueKey, fields);
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    await this.client.addComment(issueKey, body);
  }

  async createIssue(projectKey: string, data: { title: string; description: string }): Promise<NormalizedIssue> {
    const result = await this.client.createIssue(projectKey, { summary: data.title, description: data.description });
    return {
      id: result.key,
      title: data.title,
      description: data.description,
      status: "open",
      provider_url: result.self,
    };
  }

  private mapStatus(jiraStatus: string): "open" | "closed" | "in_progress" {
    const lower = jiraStatus.toLowerCase();
    if (lower === "done" || lower === "closed" || lower === "resolved") return "closed";
    if (lower === "in progress" || lower === "in review") return "in_progress";
    return "open";
  }
}
