import { vi, describe, it, expect } from "vitest";
import { GitHubConnector } from "../../src/connectors/github/github";

describe("GitHubConnector", () => {
  it("should hydrate a normalize issue model from a github issue", async () => {
    // Mock octokit response
    const mockOctokit = {
      rest: {
        issues: {
          get: vi.fn(async () => ({
            data: {
              number: 42,
              title: "Test Issue",
              body: "This is a test issue body",
              state: "open",
              html_url: "https://github.com/anomalyco/opencode/issues/42"
            }
          })),
          update: vi.fn(async () => ({})),
          createComment: vi.fn(async () => ({})),
          create: vi.fn(async () => ({
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
    const updateMock = vi.fn(async () => ({}));
    const mockOctokit = {
      rest: {
        issues: {
          get: vi.fn(async () => ({})),
          update: updateMock,
          createComment: vi.fn(async () => ({})),
          create: vi.fn(async () => ({}))
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
    const createCommentMock = vi.fn(async () => ({}));
    const mockOctokit = {
      rest: {
        issues: {
          get: vi.fn(async () => ({})),
          update: vi.fn(async () => ({})),
          createComment: createCommentMock,
          create: vi.fn(async () => ({}))
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
    const createMock = vi.fn(async () => ({
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
          get: vi.fn(async () => ({})),
          update: vi.fn(async () => ({})),
          createComment: vi.fn(async () => ({})),
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
          get: vi.fn(async () => ({})),
          update: vi.fn(async () => ({})),
          createComment: vi.fn(async () => ({})),
          create: vi.fn(async () => ({
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

  it("should validate the authenticated user", async () => {
    const mockOctokit = {
      rest: {
        users: {
          getAuthenticated: vi.fn(async () => ({ data: { login: "octocat" } })),
        },
        issues: {
          get: vi.fn(async () => ({})),
          update: vi.fn(async () => ({})),
          createComment: vi.fn(async () => ({})),
          create: vi.fn(async () => ({})),
        },
        search: {
          issuesAndPullRequests: vi.fn(async () => ({ data: { items: [] } })),
        },
      },
    };

    const connector = new GitHubConnector(mockOctokit as any);
    await expect(connector.validate()).resolves.toEqual({ label: "octocat" });
  });

  it("should preview repo-scoped issues", async () => {
    const search = vi.fn(async () => ({
      data: {
        items: [{
          number: 42,
          repository_url: "https://api.github.com/repos/anomalyco/opencode",
        }],
      },
    }));
    const get = vi.fn(async () => ({
      data: {
        number: 42,
        title: "Preview me",
        body: "Body",
        state: "open",
        html_url: "https://github.com/anomalyco/opencode/issues/42",
      },
    }));
    const mockOctokit = {
      rest: {
        users: {
          getAuthenticated: vi.fn(async () => ({ data: { login: "octocat" } })),
        },
        issues: {
          get,
          update: vi.fn(async () => ({})),
          createComment: vi.fn(async () => ({})),
          create: vi.fn(async () => ({})),
        },
        search: {
          issuesAndPullRequests: search,
        },
      },
    };

    const connector = new GitHubConnector(mockOctokit as any);
    const items = await connector.queryIssues("assigned_to_me", { owner: "anomalyco", repo: "opencode" });

    expect(search).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
    expect(items[0].provider).toBe("github");
    expect(items[0].provider_meta).toEqual({ owner: "anomalyco", repo: "opencode", issueNumber: 42 });
  });
});
