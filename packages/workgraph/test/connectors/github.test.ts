import { describe, it, expect, mock } from "bun:test";
import { GitHubConnector } from "../src/github";

describe("GitHubConnector", () => {
  it("should hydrate a normalize issue model from a github issue", async () => {
    // Mock octokit response
    const mockOctokit = {
      rest: {
        issues: {
          get: mock(async () => ({
            data: {
              number: 42,
              title: "Test Issue",
              body: "This is a test issue body",
              state: "open",
              html_url: "https://github.com/anomalyco/opencode/issues/42"
            }
          })),
          update: mock(async () => ({})),
          createComment: mock(async () => ({})),
          create: mock(async () => ({
            data: {
              number: 99,
              title: "New Issue",
              body: "New issue body",
              state: "open",
              html_url: "https://github.com/anomalyco/opencode/issues/99"
            }
          }))
        }
      }
    };

    const connector = new GitHubConnector(mockOctokit as any);
    const issue = await connector.hydrateIssue("anomalyco", "opencode", 42);

    expect(issue.id).toBe("42");
    expect(issue.title).toBe("Test Issue");
    expect(issue.description).toBe("This is a test issue body");
    expect(issue.status).toBe("open");
    expect(issue.provider_url).toBe("https://github.com/anomalyco/opencode/issues/42");
  });

  it("should update an issue", async () => {
    const updateMock = mock(async () => ({}));
    const mockOctokit = {
      rest: {
        issues: {
          get: mock(async () => ({})),
          update: updateMock,
          createComment: mock(async () => ({})),
          create: mock(async () => ({}))
        }
      }
    };

    const connector = new GitHubConnector(mockOctokit as any);
    await connector.updateIssue("anomalyco", "opencode", 42, { title: "Updated Title", state: "closed" });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      owner: "anomalyco",
      repo: "opencode",
      issue_number: 42,
      title: "Updated Title",
      state: "closed"
    });
  });

  it("should add a comment to an issue", async () => {
    const createCommentMock = mock(async () => ({}));
    const mockOctokit = {
      rest: {
        issues: {
          get: mock(async () => ({})),
          update: mock(async () => ({})),
          createComment: createCommentMock,
          create: mock(async () => ({}))
        }
      }
    };

    const connector = new GitHubConnector(mockOctokit as any);
    await connector.addComment("anomalyco", "opencode", 42, "This is a comment");

    expect(createCommentMock).toHaveBeenCalledTimes(1);
    expect(createCommentMock).toHaveBeenCalledWith({
      owner: "anomalyco",
      repo: "opencode",
      issue_number: 42,
      body: "This is a comment"
    });
  });

  it("should create a new issue", async () => {
    const createMock = mock(async () => ({
      data: {
        number: 99,
        title: "New Issue",
        body: "New issue body",
        state: "open",
        html_url: "https://github.com/anomalyco/opencode/issues/99"
      }
    }));
    const mockOctokit = {
      rest: {
        issues: {
          get: mock(async () => ({})),
          update: mock(async () => ({})),
          createComment: mock(async () => ({})),
          create: createMock
        }
      }
    };

    const connector = new GitHubConnector(mockOctokit as any);
    const issue = await connector.createIssue("anomalyco", "opencode", { title: "New Issue", body: "New issue body" });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      owner: "anomalyco",
      repo: "opencode",
      title: "New Issue",
      body: "New issue body"
    });

    expect(issue.id).toBe("99");
    expect(issue.title).toBe("New Issue");
    expect(issue.description).toBe("New issue body");
    expect(issue.status).toBe("open");
    expect(issue.provider_url).toBe("https://github.com/anomalyco/opencode/issues/99");
  });

  it("should map closed state correctly on create", async () => {
    const mockOctokit = {
      rest: {
        issues: {
          get: mock(async () => ({})),
          update: mock(async () => ({})),
          createComment: mock(async () => ({})),
          create: mock(async () => ({
            data: {
              number: 100,
              title: "Closed Issue",
              body: "Body",
              state: "closed",
              html_url: "https://github.com/anomalyco/opencode/issues/100"
            }
          }))
        }
      }
    };

    const connector = new GitHubConnector(mockOctokit as any);
    const issue = await connector.createIssue("anomalyco", "opencode", { title: "Closed Issue", body: "Body" });
    expect(issue.status).toBe("closed");
  });
});
