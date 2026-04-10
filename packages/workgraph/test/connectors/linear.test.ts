import { vi, describe, it, expect } from "vitest";
import { LinearConnector } from "../../src/connectors/linear/linear";

describe("LinearConnector", () => {
  function createMockClient() {
    return {
      getIssue: vi.fn(async (issueId: string) => ({
        id: issueId,
        title: "Test Linear Issue",
        description: "A linear issue description",
        state: { name: "Todo" },
        url: `https://linear.app/team/issue/${issueId}`,
      })),
      updateIssue: vi.fn(async () => {}),
      createComment: vi.fn(async () => {}),
      createIssue: vi.fn(async (_teamId: string, input: Record<string, any>) => ({
        id: "issue-new-123",
        title: input.title,
        description: input.description,
        state: { name: "Todo" },
        url: "https://linear.app/team/issue/issue-new-123",
      })),
      getViewer: vi.fn(async () => ({ id: "viewer-1", email: "linear@example.com" })),
      listIssues: vi.fn(async () => [{ id: "issue-42" }]),
    };
  }

  it("should hydrate a normalized issue from Linear", async () => {
    const client = createMockClient();
    const connector = new LinearConnector(client);
    const issue = await connector.hydrateIssue("issue-42");

    expect(issue.id).toBe("issue-42");
    expect(issue.title).toBe("Test Linear Issue");
    expect(issue.description).toBe("A linear issue description");
    expect(issue.status).toBe("open");
    expect(issue.provider_url).toBe("https://linear.app/team/issue/issue-42");
    expect(client.getIssue).toHaveBeenCalledWith("issue-42");
  });

  it("should update an issue", async () => {
    const client = createMockClient();
    const connector = new LinearConnector(client);
    await connector.updateIssue("issue-42", { title: "Updated Title", description: "Updated desc", status: "in_progress" });

    expect(client.updateIssue).toHaveBeenCalledTimes(1);
    expect(client.updateIssue).toHaveBeenCalledWith("issue-42", {
      title: "Updated Title",
      description: "Updated desc",
      status: "in_progress",
    });
  });

  it("should add a comment", async () => {
    const client = createMockClient();
    const connector = new LinearConnector(client);
    await connector.addComment("issue-42", "This is a comment");

    expect(client.createComment).toHaveBeenCalledTimes(1);
    expect(client.createComment).toHaveBeenCalledWith("issue-42", "This is a comment");
  });

  it("should create a new issue", async () => {
    const client = createMockClient();
    const connector = new LinearConnector(client);
    const issue = await connector.createIssue("team-1", { title: "New Issue", description: "New desc" });

    expect(client.createIssue).toHaveBeenCalledTimes(1);
    expect(client.createIssue).toHaveBeenCalledWith("team-1", {
      title: "New Issue",
      description: "New desc",
    });
    expect(issue.id).toBe("issue-new-123");
    expect(issue.title).toBe("New Issue");
    expect(issue.description).toBe("New desc");
    expect(issue.status).toBe("open");
    expect(issue.provider_url).toBe("https://linear.app/team/issue/issue-new-123");
  });

  it("should map 'Done' status to closed", async () => {
    const client = createMockClient();
    client.getIssue = vi.fn(async () => ({
      id: "issue-1",
      title: "Done Issue",
      description: "",
      state: { name: "Done" },
      url: "https://linear.app/team/issue/issue-1",
    }));
    const connector = new LinearConnector(client);
    const issue = await connector.hydrateIssue("issue-1");
    expect(issue.status).toBe("closed");
  });

  it("should map 'Canceled' status to closed", async () => {
    const client = createMockClient();
    client.getIssue = vi.fn(async () => ({
      id: "issue-2",
      title: "Canceled Issue",
      description: "",
      state: { name: "Canceled" },
      url: "https://linear.app/team/issue/issue-2",
    }));
    const connector = new LinearConnector(client);
    const issue = await connector.hydrateIssue("issue-2");
    expect(issue.status).toBe("closed");
  });

  it("should map 'Cancelled' status to closed", async () => {
    const client = createMockClient();
    client.getIssue = vi.fn(async () => ({
      id: "issue-3",
      title: "Cancelled Issue",
      description: "",
      state: { name: "Cancelled" },
      url: "https://linear.app/team/issue/issue-3",
    }));
    const connector = new LinearConnector(client);
    const issue = await connector.hydrateIssue("issue-3");
    expect(issue.status).toBe("closed");
  });

  it("should map 'In Progress' status to in_progress", async () => {
    const client = createMockClient();
    client.getIssue = vi.fn(async () => ({
      id: "issue-4",
      title: "WIP Issue",
      description: "",
      state: { name: "In Progress" },
      url: "https://linear.app/team/issue/issue-4",
    }));
    const connector = new LinearConnector(client);
    const issue = await connector.hydrateIssue("issue-4");
    expect(issue.status).toBe("in_progress");
  });

  it("should map 'Started' status to in_progress", async () => {
    const client = createMockClient();
    client.getIssue = vi.fn(async () => ({
      id: "issue-5",
      title: "Started Issue",
      description: "",
      state: { name: "Started" },
      url: "https://linear.app/team/issue/issue-5",
    }));
    const connector = new LinearConnector(client);
    const issue = await connector.hydrateIssue("issue-5");
    expect(issue.status).toBe("in_progress");
  });

  it("should handle missing state gracefully", async () => {
    const client = createMockClient();
    client.getIssue = vi.fn(async () => ({
      id: "issue-6",
      title: "No State Issue",
      description: "",
      state: null,
      url: "https://linear.app/team/issue/issue-6",
    }));
    const connector = new LinearConnector(client);
    const issue = await connector.hydrateIssue("issue-6");
    expect(issue.status).toBe("open");
  });

  it("should validate the current viewer", async () => {
    const client = createMockClient();
    const connector = new LinearConnector(client);
    await expect(connector.validate()).resolves.toEqual({ label: "linear@example.com" });
  });

  it("should preview non-single-item queries", async () => {
    const client = createMockClient();
    const connector = new LinearConnector(client);
    const items = await connector.queryIssues("project_or_team", { team_id: "team-1" });

    expect(client.listIssues).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
    expect(items[0].provider).toBe("linear");
    expect(items[0].provider_meta).toEqual({ issueId: "issue-42" });
  });
});
