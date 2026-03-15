/**
 * Unit tests for the Linear connector with mocked HTTP client.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { LinearConnector } from "../../src/connectors/linear/linear";

function makeClient(overrides: Record<string, any> = {}) {
  return {
    getIssue: mock(async (issueId: string) => ({
      id: issueId,
      title: `Linear Issue ${issueId}`,
      description: "A linear description",
      state: { name: "Todo" },
      url: `https://linear.app/team/issue/${issueId}`,
    })),
    updateIssue: mock(async () => {}),
    createComment: mock(async () => {}),
    createIssue: mock(async (_teamId: string, input: Record<string, any>) => ({
      id: "LIN-100",
      title: input.title,
      description: input.description,
      state: { name: "Todo" },
      url: "https://linear.app/team/issue/LIN-100",
    })),
    getViewer: mock(async () => ({ id: "viewer-1", email: "user@linear.app" })),
    listIssues: mock(async (_: any) => [{ id: "LIN-1" }, { id: "LIN-2" }]),
    ...overrides,
  };
}

describe("LinearConnector.hydrateIssue", () => {
  it("returns normalized issue", async () => {
    const client = makeClient();
    const connector = new LinearConnector(client);
    const issue = await connector.hydrateIssue("LIN-42");

    expect(issue.id).toBe("LIN-42");
    expect(issue.title).toBe("Linear Issue LIN-42");
    expect(issue.description).toBe("A linear description");
    expect(issue.status).toBe("open");
    expect(issue.provider_url).toContain("LIN-42");
    expect(client.getIssue).toHaveBeenCalledWith("LIN-42");
  });

  it("maps 'Done' to closed", async () => {
    const client = makeClient({ getIssue: mock(async () => ({ id: "x", title: "x", description: "", state: { name: "Done" }, url: "https://linear.app/x" })) });
    const issue = await new LinearConnector(client).hydrateIssue("x");
    expect(issue.status).toBe("closed");
  });

  it("maps 'Canceled' to closed", async () => {
    const client = makeClient({ getIssue: mock(async () => ({ id: "x", title: "x", description: "", state: { name: "Canceled" }, url: "https://linear.app/x" })) });
    const issue = await new LinearConnector(client).hydrateIssue("x");
    expect(issue.status).toBe("closed");
  });

  it("maps 'Cancelled' to closed", async () => {
    const client = makeClient({ getIssue: mock(async () => ({ id: "x", title: "x", description: "", state: { name: "Cancelled" }, url: "https://linear.app/x" })) });
    const issue = await new LinearConnector(client).hydrateIssue("x");
    expect(issue.status).toBe("closed");
  });

  it("maps 'In Progress' to in_progress", async () => {
    const client = makeClient({ getIssue: mock(async () => ({ id: "x", title: "x", description: "", state: { name: "In Progress" }, url: "https://linear.app/x" })) });
    const issue = await new LinearConnector(client).hydrateIssue("x");
    expect(issue.status).toBe("in_progress");
  });

  it("maps 'Started' to in_progress", async () => {
    const client = makeClient({ getIssue: mock(async () => ({ id: "x", title: "x", description: "", state: { name: "Started" }, url: "https://linear.app/x" })) });
    const issue = await new LinearConnector(client).hydrateIssue("x");
    expect(issue.status).toBe("in_progress");
  });

  it("defaults to open when state is null", async () => {
    const client = makeClient({ getIssue: mock(async () => ({ id: "x", title: "x", description: "", state: null, url: "https://linear.app/x" })) });
    const issue = await new LinearConnector(client).hydrateIssue("x");
    expect(issue.status).toBe("open");
  });

  it("defaults to open for unknown state name", async () => {
    const client = makeClient({ getIssue: mock(async () => ({ id: "x", title: "x", description: "", state: { name: "Backlog" }, url: "https://linear.app/x" })) });
    const issue = await new LinearConnector(client).hydrateIssue("x");
    expect(issue.status).toBe("open");
  });
});

describe("LinearConnector.updateIssue", () => {
  it("calls client.updateIssue with correct args", async () => {
    const client = makeClient();
    const connector = new LinearConnector(client);
    await connector.updateIssue("LIN-42", { title: "Updated", status: "in_progress" });

    expect(client.updateIssue).toHaveBeenCalledTimes(1);
    expect(client.updateIssue).toHaveBeenCalledWith("LIN-42", { title: "Updated", status: "in_progress" });
  });
});

describe("LinearConnector.addComment", () => {
  it("calls client.createComment with correct args", async () => {
    const client = makeClient();
    const connector = new LinearConnector(client);
    await connector.addComment("LIN-42", "Hello comment");

    expect(client.createComment).toHaveBeenCalledTimes(1);
    expect(client.createComment).toHaveBeenCalledWith("LIN-42", "Hello comment");
  });
});

describe("LinearConnector.createIssue", () => {
  it("creates an issue and returns normalized form", async () => {
    const client = makeClient();
    const connector = new LinearConnector(client);
    const issue = await connector.createIssue("TEAM-1", { title: "New Task", description: "Do the thing" });

    expect(issue.id).toBe("LIN-100");
    expect(issue.title).toBe("New Task");
    expect(issue.status).toBe("open");
    expect(client.createIssue).toHaveBeenCalledWith("TEAM-1", { title: "New Task", description: "Do the thing" });
  });
});

describe("LinearConnector.validate", () => {
  it("returns viewer email as label", async () => {
    const client = makeClient();
    const connector = new LinearConnector(client);
    const result = await connector.validate();
    expect(result.label).toBe("user@linear.app");
  });
});

describe("LinearConnector.queryIssues", () => {
  it("lists issues for project_or_team mode", async () => {
    const client = makeClient();
    const connector = new LinearConnector(client);
    const items = await connector.queryIssues("project_or_team", { team_id: "TEAM-1" });

    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].provider).toBe("linear");
    expect(client.listIssues).toHaveBeenCalledTimes(1);
  });

  it("includes provider_meta with issueId", async () => {
    const client = makeClient();
    const connector = new LinearConnector(client);
    const items = await connector.queryIssues("project_or_team", { team_id: "TEAM-1" });
    expect(items[0].provider_meta).toHaveProperty("issueId");
  });

  it("hydrates for single_item mode", async () => {
    const client = makeClient();
    const connector = new LinearConnector(client);
    const items = await connector.queryIssues("single_item", { issueId: "LIN-1" });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("LIN-1");
    expect(client.getIssue).toHaveBeenCalledWith("LIN-1");
  });
});
