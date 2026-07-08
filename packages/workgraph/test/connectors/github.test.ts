import { vi, describe, it, expect } from "vitest";
import { GitHubConnector, type GitHubProxyRequest } from "../../src/connectors/github/github";

describe("GitHubConnector", () => {
  it("should hydrate a normalize issue model from a github issue", async () => {
    const proxy = vi.fn(async (_req: GitHubProxyRequest) => ({
      data: {
        number: 42,
        title: "Test Issue",
        body: "This is a test issue body",
        state: "open",
        html_url: "https://github.com/anomalyco/opencode/issues/42",
      },
    }));

    const connector = new GitHubConnector({ proxy });
    const issue = await connector.hydrateIssue("anomalyco", "opencode", 42);

    expect(proxy).toHaveBeenCalledTimes(1);
    expect(proxy).toHaveBeenCalledWith({
      endpoint: "/repos/anomalyco/opencode/issues/42",
      method: "GET",
    });

    expect(issue.id).toBe("42");
    expect(issue.title).toBe("Test Issue");
    expect(issue.description).toBe("This is a test issue body");
    expect(issue.status).toBe("open");
    expect(issue.provider_url).toBe("https://github.com/anomalyco/opencode/issues/42");
  });

  it("should update an issue", async () => {
    const proxy = vi.fn(async (_req: GitHubProxyRequest) => ({ data: {} }));

    const connector = new GitHubConnector({ proxy });
    await connector.updateIssue("anomalyco", "opencode", 42, { title: "Updated Title", state: "closed" });

    expect(proxy).toHaveBeenCalledTimes(1);
    expect(proxy).toHaveBeenCalledWith({
      endpoint: "/repos/anomalyco/opencode/issues/42",
      method: "PATCH",
      body: {
        title: "Updated Title",
        state: "closed",
      },
    });
  });

  it("should add a comment to an issue", async () => {
    const proxy = vi.fn(async (_req: GitHubProxyRequest) => ({ data: {} }));

    const connector = new GitHubConnector({ proxy });
    await connector.addComment("anomalyco", "opencode", 42, "This is a comment");

    expect(proxy).toHaveBeenCalledTimes(1);
    expect(proxy).toHaveBeenCalledWith({
      endpoint: "/repos/anomalyco/opencode/issues/42/comments",
      method: "POST",
      body: {
        body: "This is a comment",
      },
    });
  });

  it("should create a new issue", async () => {
    const proxy = vi.fn(async (_req: GitHubProxyRequest) => ({
      data: {
        number: 99,
        title: "New Issue",
        body: "New issue body",
        state: "open",
        html_url: "https://github.com/anomalyco/opencode/issues/99",
      },
    }));

    const connector = new GitHubConnector({ proxy });
    const issue = await connector.createIssue("anomalyco", "opencode", { title: "New Issue", body: "New issue body" });

    expect(proxy).toHaveBeenCalledTimes(1);
    expect(proxy).toHaveBeenCalledWith({
      endpoint: "/repos/anomalyco/opencode/issues",
      method: "POST",
      body: {
        title: "New Issue",
        body: "New issue body",
      },
    });

    expect(issue.id).toBe("99");
    expect(issue.title).toBe("New Issue");
    expect(issue.description).toBe("New issue body");
    expect(issue.status).toBe("open");
    expect(issue.provider_url).toBe("https://github.com/anomalyco/opencode/issues/99");
  });

  it("should map closed state correctly on create", async () => {
    const proxy = vi.fn(async (_req: GitHubProxyRequest) => ({
      data: {
        number: 100,
        title: "Closed Issue",
        body: "Body",
        state: "closed",
        html_url: "https://github.com/anomalyco/opencode/issues/100",
      },
    }));

    const connector = new GitHubConnector({ proxy });
    const issue = await connector.createIssue("anomalyco", "opencode", { title: "Closed Issue", body: "Body" });
    expect(issue.status).toBe("closed");
  });

  it("should validate the authenticated user", async () => {
    const proxy = vi.fn(async (_req: GitHubProxyRequest) => ({ data: { login: "octocat" } }));

    const connector = new GitHubConnector({ proxy });
    await expect(connector.validate()).resolves.toEqual({ label: "octocat" });

    expect(proxy).toHaveBeenCalledTimes(1);
    expect(proxy).toHaveBeenCalledWith({
      endpoint: "/user",
      method: "GET",
    });
  });

  it("should preview repo-scoped issues", async () => {
    const proxy = vi.fn(async (req: GitHubProxyRequest) => {
      if (req.endpoint === "/search/issues") {
        return {
          data: {
            items: [{
              number: 42,
              repository_url: "https://api.github.com/repos/anomalyco/opencode",
            }],
          },
        };
      }
      return {
        data: {
          number: 42,
          title: "Preview me",
          body: "Body",
          state: "open",
          html_url: "https://github.com/anomalyco/opencode/issues/42",
        },
      };
    });

    const connector = new GitHubConnector({ proxy });
    const items = await connector.queryIssues("assigned_to_me", { owner: "anomalyco", repo: "opencode" });

    const searchCalls = proxy.mock.calls.filter(([req]) => req.endpoint === "/search/issues");
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0][0].method).toBe("GET");
    const q = searchCalls[0][0].parameters?.find((p) => p.name === "q")?.value;
    expect(q).toContain("is:issue");
    expect(q).toContain("repo:anomalyco/opencode");
    expect(q).toContain("assignee:@me");

    const hydrateCalls = proxy.mock.calls.filter(([req]) => req.endpoint === "/repos/anomalyco/opencode/issues/42");
    expect(hydrateCalls).toHaveLength(1);

    expect(items).toHaveLength(1);
    expect(items[0].provider).toBe("github");
    expect(items[0].provider_meta).toEqual({ owner: "anomalyco", repo: "opencode", issueNumber: 42 });
  });
});
