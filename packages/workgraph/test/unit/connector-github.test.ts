/**
 * Unit tests for the GitHub connector with mocked HTTP client.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { GitHubConnector } from "../../src/connectors/github/github";

function makeOctokit(overrides: Record<string, any> = {}) {
  const base = {
    rest: {
      issues: {
        get: mock(async ({ issue_number }: any) => ({
          data: {
            number: issue_number,
            title: `Issue ${issue_number}`,
            body: "Issue body",
            state: "open",
            html_url: `https://github.com/owner/repo/issues/${issue_number}`,
          },
        })),
        update: mock(async () => ({ data: {} })),
        createComment: mock(async () => ({ data: {} })),
        create: mock(async ({ title, body }: any) => ({
          data: {
            number: 99,
            title,
            body: body ?? "",
            state: "open",
            html_url: "https://github.com/owner/repo/issues/99",
          },
        })),
      },
      users: {
        getAuthenticated: mock(async () => ({
          data: { login: "testuser" },
        })),
      },
      search: {
        issuesAndPullRequests: mock(async () => ({
          data: {
            items: [
              {
                number: 5,
                repository_url: "https://api.github.com/repos/owner/repo",
                title: "Found issue",
                body: "body",
                state: "open",
                html_url: "https://github.com/owner/repo/issues/5",
              },
            ],
          },
        })),
      },
    },
    ...overrides,
  };
  return base as any;
}

describe("GitHubConnector.hydrateIssue", () => {
  it("returns normalized issue from GitHub", async () => {
    const octokit = makeOctokit();
    const connector = new GitHubConnector(octokit);
    const issue = await connector.hydrateIssue("owner", "repo", 42);

    expect(issue.id).toBe("42");
    expect(issue.title).toBe("Issue 42");
    expect(issue.description).toBe("Issue body");
    expect(issue.status).toBe("open");
    expect(issue.provider_url).toContain("42");
    expect(issue.external_key).toBe("owner/repo#42");
    expect(octokit.rest.issues.get).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      issue_number: 42,
    });
  });

  it("maps closed state correctly", async () => {
    const octokit = makeOctokit();
    octokit.rest.issues.get = mock(async () => ({
      data: {
        number: 10,
        title: "Closed issue",
        body: "",
        state: "closed",
        html_url: "https://github.com/owner/repo/issues/10",
      },
    }));
    const connector = new GitHubConnector(octokit);
    const issue = await connector.hydrateIssue("owner", "repo", 10);
    expect(issue.status).toBe("closed");
  });

  it("includes child_external_keys from tracked_issues", async () => {
    const octokit = makeOctokit();
    octokit.rest.issues.get = mock(async () => ({
      data: {
        number: 1,
        title: "Parent",
        body: "",
        state: "open",
        html_url: "https://github.com/owner/repo/issues/1",
        tracked_issues: [{ number: 2 }, { number: 3 }],
      },
    }));
    const connector = new GitHubConnector(octokit);
    const issue = await connector.hydrateIssue("owner", "repo", 1);
    expect(issue.child_external_keys).toContain("owner/repo#2");
    expect(issue.child_external_keys).toContain("owner/repo#3");
    expect(issue.aggregate_only).toBe(true);
  });

  it("sets aggregate_only=false when no children", async () => {
    const octokit = makeOctokit();
    const connector = new GitHubConnector(octokit);
    const issue = await connector.hydrateIssue("owner", "repo", 42);
    expect(issue.aggregate_only).toBe(false);
  });
});

describe("GitHubConnector.updateIssue", () => {
  it("calls octokit update with correct params", async () => {
    const octokit = makeOctokit();
    const connector = new GitHubConnector(octokit);
    await connector.updateIssue("owner", "repo", 42, { title: "New title", state: "closed" });

    expect(octokit.rest.issues.update).toHaveBeenCalledTimes(1);
    const call = (octokit.rest.issues.update as any).mock.calls[0][0];
    expect(call.owner).toBe("owner");
    expect(call.repo).toBe("repo");
    expect(call.issue_number).toBe(42);
    expect(call.title).toBe("New title");
  });
});

describe("GitHubConnector.addComment", () => {
  it("calls createComment with body", async () => {
    const octokit = makeOctokit();
    const connector = new GitHubConnector(octokit);
    await connector.addComment("owner", "repo", 42, "This is a comment");

    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const call = (octokit.rest.issues.createComment as any).mock.calls[0][0];
    expect(call.body).toBe("This is a comment");
    expect(call.issue_number).toBe(42);
  });
});

describe("GitHubConnector.createIssue", () => {
  it("creates an issue and returns normalized form", async () => {
    const octokit = makeOctokit();
    const connector = new GitHubConnector(octokit);
    const issue = await connector.createIssue("owner", "repo", { title: "New Issue", body: "body text" });

    expect(issue.id).toBe("99");
    expect(issue.title).toBe("New Issue");
    expect(issue.status).toBe("open");
    expect(octokit.rest.issues.create).toHaveBeenCalledTimes(1);
  });
});

describe("GitHubConnector.validate", () => {
  it("returns authenticated user login as label", async () => {
    const octokit = makeOctokit();
    const connector = new GitHubConnector(octokit);
    const result = await connector.validate();
    expect(result.label).toBe("testuser");
  });
});

describe("GitHubConnector.queryIssues — single_item", () => {
  it("returns single normalized issue", async () => {
    const octokit = makeOctokit();
    const connector = new GitHubConnector(octokit);
    const items = await connector.queryIssues("single_item", { owner: "owner", repo: "repo", issueNumber: 42 });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("42");
    expect(items[0].provider).toBe("github");
    expect(items[0].provider_meta.issueNumber).toBe(42);
  });

  it("throws when params incomplete", async () => {
    const octokit = makeOctokit();
    const connector = new GitHubConnector(octokit);
    await expect(connector.queryIssues("single_item", {})).rejects.toThrow();
  });
});

describe("GitHubConnector.queryIssues — assigned_to_me", () => {
  it("searches for issues assigned to me and returns results", async () => {
    const octokit = makeOctokit();
    // queryIssues calls hydrateIssue per result item
    const connector = new GitHubConnector(octokit);
    const items = await connector.queryIssues("assigned_to_me", { owner: "owner", repo: "repo" });

    expect(Array.isArray(items)).toBe(true);
    expect(octokit.rest.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);
    const call = (octokit.rest.search.issuesAndPullRequests as any).mock.calls[0][0];
    expect(call.q).toContain("assignee:@me");
  });
});
