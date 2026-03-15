import { describe, it, expect, mock } from "bun:test";
import { JiraConnector } from "../../src/connectors/jira/jira";

describe("JiraConnector", () => {
  function createMockClient() {
    return {
      getIssue: mock(async (issueKey: string) => ({
        key: issueKey,
        self: `https://jira.example.com/rest/api/2/issue/${issueKey}`,
        fields: {
          summary: "Test Jira Issue",
          description: "A test description",
          status: { name: "Open" },
        },
      })),
      updateIssue: mock(async () => {}),
      addComment: mock(async () => {}),
      createIssue: mock(async (_projectKey: string, fields: Record<string, any>) => ({
        key: "PROJ-100",
        self: "https://jira.example.com/rest/api/2/issue/PROJ-100",
        fields: {
          summary: fields.summary,
          description: fields.description,
          status: { name: "Open" },
        },
      })),
    };
  }

  it("should hydrate a normalized issue from Jira", async () => {
    const client = createMockClient();
    const connector = new JiraConnector(client);
    const issue = await connector.hydrateIssue("PROJ-42");

    expect(issue.id).toBe("PROJ-42");
    expect(issue.title).toBe("Test Jira Issue");
    expect(issue.description).toBe("A test description");
    expect(issue.status).toBe("open");
    expect(issue.provider_url).toBe("https://jira.example.com/rest/api/2/issue/PROJ-42");
    expect(client.getIssue).toHaveBeenCalledWith("PROJ-42");
  });

  it("should update an issue", async () => {
    const client = createMockClient();
    const connector = new JiraConnector(client);
    await connector.updateIssue("PROJ-42", { title: "Updated Title", description: "Updated desc", status: "in_progress" });

    expect(client.updateIssue).toHaveBeenCalledTimes(1);
    expect(client.updateIssue).toHaveBeenCalledWith("PROJ-42", {
      summary: "Updated Title",
      description: "Updated desc",
      status: "in_progress",
    });
  });

  it("should add a comment", async () => {
    const client = createMockClient();
    const connector = new JiraConnector(client);
    await connector.addComment("PROJ-42", "This is a comment");

    expect(client.addComment).toHaveBeenCalledTimes(1);
    expect(client.addComment).toHaveBeenCalledWith("PROJ-42", "This is a comment");
  });

  it("should create a new issue", async () => {
    const client = createMockClient();
    const connector = new JiraConnector(client);
    const issue = await connector.createIssue("PROJ", { title: "New Issue", description: "New desc" });

    expect(client.createIssue).toHaveBeenCalledTimes(1);
    expect(client.createIssue).toHaveBeenCalledWith("PROJ", {
      summary: "New Issue",
      description: "New desc",
    });
    expect(issue.id).toBe("PROJ-100");
    expect(issue.title).toBe("New Issue");
    expect(issue.description).toBe("New desc");
    expect(issue.status).toBe("open");
    expect(issue.provider_url).toBe("https://jira.example.com/rest/api/2/issue/PROJ-100");
  });

  it("should map 'Done' status to closed", async () => {
    const client = createMockClient();
    client.getIssue = mock(async () => ({
      key: "PROJ-1",
      self: "https://jira.example.com/rest/api/2/issue/PROJ-1",
      fields: { summary: "Done Issue", description: "", status: { name: "Done" } },
    }));
    const connector = new JiraConnector(client);
    const issue = await connector.hydrateIssue("PROJ-1");
    expect(issue.status).toBe("closed");
  });

  it("should map 'Resolved' status to closed", async () => {
    const client = createMockClient();
    client.getIssue = mock(async () => ({
      key: "PROJ-2",
      self: "https://jira.example.com/rest/api/2/issue/PROJ-2",
      fields: { summary: "Resolved Issue", description: "", status: { name: "Resolved" } },
    }));
    const connector = new JiraConnector(client);
    const issue = await connector.hydrateIssue("PROJ-2");
    expect(issue.status).toBe("closed");
  });

  it("should map 'In Progress' status to in_progress", async () => {
    const client = createMockClient();
    client.getIssue = mock(async () => ({
      key: "PROJ-3",
      self: "https://jira.example.com/rest/api/2/issue/PROJ-3",
      fields: { summary: "WIP Issue", description: "", status: { name: "In Progress" } },
    }));
    const connector = new JiraConnector(client);
    const issue = await connector.hydrateIssue("PROJ-3");
    expect(issue.status).toBe("in_progress");
  });

  it("should map 'In Review' status to in_progress", async () => {
    const client = createMockClient();
    client.getIssue = mock(async () => ({
      key: "PROJ-4",
      self: "https://jira.example.com/rest/api/2/issue/PROJ-4",
      fields: { summary: "Review Issue", description: "", status: { name: "In Review" } },
    }));
    const connector = new JiraConnector(client);
    const issue = await connector.hydrateIssue("PROJ-4");
    expect(issue.status).toBe("in_progress");
  });

  it("should map unknown status to open", async () => {
    const client = createMockClient();
    client.getIssue = mock(async () => ({
      key: "PROJ-5",
      self: "https://jira.example.com/rest/api/2/issue/PROJ-5",
      fields: { summary: "Custom Issue", description: "", status: { name: "Custom Status" } },
    }));
    const connector = new JiraConnector(client);
    const issue = await connector.hydrateIssue("PROJ-5");
    expect(issue.status).toBe("open");
  });
});
