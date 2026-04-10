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

interface JiraClient {
  getIssue(issueKey: string): Promise<JiraIssue>;
  updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void>;
  addComment(issueKey: string, body: string): Promise<void>;
  createIssue(projectKey: string, fields: Record<string, unknown>): Promise<{ key: string; self: string }>;
}

export class JiraConnector {
  private client: JiraClient;

  constructor(client: JiraClient) {
    this.client = client;
  }

  async hydrateIssue(issueKey: string): Promise<NormalizedIssue> {
    const data = await this.client.getIssue(issueKey);
    const childKeys = refs(data.fields?.subtasks)
      .concat(refs(data.fields?.children))
    return {
      id: data.key,
      title: data.fields.summary,
      description: data.fields.description || "",
      status: this.mapStatus(data.fields.status.name),
      provider_url: data.self,
      external_key: data.key,
      parent_external_key: ref(data.fields?.parent),
      child_external_keys: childKeys,
      aggregate_only: typeof data.fields?.aggregate_only === "boolean" ? data.fields.aggregate_only : childKeys.length > 0,
    };
  }

  async updateIssue(issueKey: string, updates: { title?: string; status?: string; description?: string }): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (updates.title) fields.summary = updates.title;
    if (updates.description) fields.description = updates.description;
    if (updates.status) fields.status = updates.status;
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

function ref(input: unknown) {
  const row = item(input)
  if (!row) return
  if (typeof row.key === "string") return row.key
  if (typeof row.id === "string") return row.id
}

function refs(input: unknown) {
  if (!Array.isArray(input)) return []
  return input
    .map((row) => ref(row))
    .filter((item): item is string => !!item)
}

type JiraRef = {
  id?: string
  key?: string
}

type JiraIssue = {
  key: string
  self: string
  fields: {
    summary: string
    description?: string | null
    status: {
      name: string
    }
    parent?: JiraRef | null
    subtasks?: JiraRef[] | null
    children?: JiraRef[] | null
    aggregate_only?: boolean
  }
}

function item(value: unknown) {
  if (!value || typeof value !== "object") return
  return value as JiraRef
}
