/**
 * MockConnector — a deterministic ConnectorInterface for testing connectors.
 *
 * Returns fixture issues deterministically based on configured fixtures.
 * Supports recording calls for assertion in tests.
 */

import type {
  ConnectorInterface,
  NormalizedIssue,
  ProviderPreview,
  ProviderQueryMode,
} from "../../src/orchestrator/events/connector";

export interface IssueFixture extends NormalizedIssue {
  provider?: string;
  provider_meta?: Record<string, any>;
}

export class MockConnector implements ConnectorInterface {
  provider: string;
  private fixtures: Map<string, IssueFixture> = new Map();
  private createdIssues: NormalizedIssue[] = [];

  // Call recording
  calls: Array<{ method: string; args: unknown[] }> = [];

  constructor(provider = "mock") {
    this.provider = provider;
  }

  /** Register a fixture issue keyed by the params.issueId or similar string */
  addFixture(key: string, issue: Partial<IssueFixture> & { id: string; title: string }): this {
    this.fixtures.set(key, {
      description: "",
      status: "open",
      provider_url: `https://mock.example.com/issue/${issue.id}`,
      ...issue,
    } as IssueFixture);
    return this;
  }

  async validate(): Promise<{ label?: string }> {
    this.calls.push({ method: "validate", args: [] });
    return { label: `mock-${this.provider}@example.com` };
  }

  async queryIssues(
    mode: ProviderQueryMode,
    params: Record<string, any>,
  ): Promise<ProviderPreview[]> {
    this.calls.push({ method: "queryIssues", args: [mode, params] });
    return Array.from(this.fixtures.values()).map((f) => ({
      ...f,
      provider: this.provider as any,
      provider_meta: f.provider_meta ?? { issueId: f.id },
    }));
  }

  async hydrateIssue(params: Record<string, any>): Promise<NormalizedIssue> {
    this.calls.push({ method: "hydrateIssue", args: [params] });
    const key = params.issueId ?? params.id ?? params.key ?? Object.values(params)[0];
    const fixture = this.fixtures.get(String(key));
    if (!fixture) {
      throw new Error(`MockConnector: no fixture for key "${key}" (params: ${JSON.stringify(params)})`);
    }
    return { ...fixture };
  }

  async updateIssue(
    params: Record<string, any>,
    updates: { title?: string; status?: string; description?: string },
  ): Promise<void> {
    this.calls.push({ method: "updateIssue", args: [params, updates] });
    const key = params.issueId ?? params.id ?? params.key ?? Object.values(params)[0];
    const fixture = this.fixtures.get(String(key));
    if (fixture) {
      if (updates.title !== undefined) fixture.title = updates.title;
      if (updates.description !== undefined) fixture.description = updates.description;
      if (updates.status !== undefined)
        fixture.status = updates.status as NormalizedIssue["status"];
    }
  }

  async addComment(params: Record<string, any>, comment: string): Promise<void> {
    this.calls.push({ method: "addComment", args: [params, comment] });
  }

  async createIssue(
    params: Record<string, any>,
    data: { title: string; description: string },
  ): Promise<NormalizedIssue> {
    this.calls.push({ method: "createIssue", args: [params, data] });
    const newIssue: NormalizedIssue = {
      id: `mock-issue-${this.createdIssues.length + 1}`,
      title: data.title,
      description: data.description,
      status: "open",
      provider_url: `https://mock.example.com/issue/new-${this.createdIssues.length + 1}`,
    };
    this.createdIssues.push(newIssue);
    return newIssue;
  }

  /** Count calls by method name */
  callCount(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  /** Reset all recorded calls */
  resetCalls(): void {
    this.calls = [];
  }
}
