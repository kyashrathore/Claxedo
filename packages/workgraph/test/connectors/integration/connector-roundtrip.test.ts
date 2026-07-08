import { vi, describe, it, expect, beforeEach } from "vitest";
import { GitHubConnector, type GitHubProxyRequest } from "../../../src/connectors/github/github";

type IssueData = Record<string, unknown>;

const defaultGetIssue: IssueData = {
  number: 42,
  title: "Original Title",
  body: "Original body content",
  state: "open",
  html_url: "https://github.com/test-org/test-repo/issues/42",
};

const defaultCreatedIssue: IssueData = {
  number: 100,
  title: "New Issue Title",
  body: "New issue body",
  state: "open",
  html_url: "https://github.com/test-org/test-repo/issues/100",
};

function makeProxy(responses: { get?: IssueData; create?: IssueData } = {}) {
  const getIssue = responses.get ?? defaultGetIssue;
  const createdIssue = responses.create ?? defaultCreatedIssue;
  return vi.fn(async (req: GitHubProxyRequest) => {
    if (req.method === "GET") return { data: getIssue };
    if (req.method === "POST" && req.endpoint.endsWith("/comments")) return { data: {} };
    if (req.method === "POST") return { data: createdIssue };
    return { data: {} }; // PATCH updates
  });
}

function callsBy(proxy: ReturnType<typeof makeProxy>, predicate: (req: GitHubProxyRequest) => boolean) {
  return proxy.mock.calls.filter(([req]) => predicate(req)).map(([req]) => req);
}

const isGet = (req: GitHubProxyRequest) => req.method === "GET";
const isUpdate = (req: GitHubProxyRequest) => req.method === "PATCH";
const isComment = (req: GitHubProxyRequest) => req.method === "POST" && req.endpoint.endsWith("/comments");
const isCreate = (req: GitHubProxyRequest) => req.method === "POST" && req.endpoint.endsWith("/issues");

describe("GitHub Connector Round-Trip Integration", () => {
  let proxy: ReturnType<typeof makeProxy>;
  let connector: GitHubConnector;

  beforeEach(() => {
    proxy = makeProxy();
    connector = new GitHubConnector({ proxy });
  });

  describe("Hydrate issue", () => {
    it("should hydrate an issue into NormalizedIssue model", async () => {
      const issue = await connector.hydrateIssue("test-org", "test-repo", 42);

      expect(issue.id).toBe("42");
      expect(issue.title).toBe("Original Title");
      expect(issue.description).toBe("Original body content");
      expect(issue.status).toBe("open");
      expect(issue.provider_url).toBe("https://github.com/test-org/test-repo/issues/42");

      expect(proxy).toHaveBeenCalledTimes(1);
      expect(proxy).toHaveBeenCalledWith({
        endpoint: "/repos/test-org/test-repo/issues/42",
        method: "GET",
      });
    });

    it("should map closed state correctly", async () => {
      proxy = makeProxy({
        get: {
          number: 43,
          title: "Closed Issue",
          body: "This issue is closed",
          state: "closed",
          html_url: "https://github.com/test-org/test-repo/issues/43",
        },
      });

      const closedConnector = new GitHubConnector({ proxy });
      const issue = await closedConnector.hydrateIssue("test-org", "test-repo", 43);

      expect(issue.status).toBe("closed");
    });

    it("should handle null body as empty string", async () => {
      proxy = makeProxy({
        get: {
          number: 44,
          title: "No Body",
          body: null,
          state: "open",
          html_url: "https://github.com/test-org/test-repo/issues/44",
        },
      });

      const noBodyConnector = new GitHubConnector({ proxy });
      const issue = await noBodyConnector.hydrateIssue("test-org", "test-repo", 44);

      expect(issue.description).toBe("");
    });
  });

  describe("Update issue", () => {
    it("should update title and state", async () => {
      await connector.updateIssue("test-org", "test-repo", 42, {
        title: "Updated Title",
        state: "closed",
      });

      expect(proxy).toHaveBeenCalledTimes(1);
      expect(proxy).toHaveBeenCalledWith({
        endpoint: "/repos/test-org/test-repo/issues/42",
        method: "PATCH",
        body: {
          title: "Updated Title",
          state: "closed",
        },
      });
    });

    it("should update only title", async () => {
      await connector.updateIssue("test-org", "test-repo", 42, {
        title: "New Title Only",
      });

      expect(proxy).toHaveBeenCalledTimes(1);
      expect(proxy).toHaveBeenCalledWith({
        endpoint: "/repos/test-org/test-repo/issues/42",
        method: "PATCH",
        body: {
          title: "New Title Only",
        },
      });
    });

    it("should update only state", async () => {
      await connector.updateIssue("test-org", "test-repo", 42, {
        state: "open",
      });

      expect(proxy).toHaveBeenCalledTimes(1);
      expect(proxy).toHaveBeenCalledWith({
        endpoint: "/repos/test-org/test-repo/issues/42",
        method: "PATCH",
        body: {
          state: "open",
        },
      });
    });
  });

  describe("Add comment", () => {
    it("should add a comment to an issue", async () => {
      await connector.addComment("test-org", "test-repo", 42, "This is a review comment");

      expect(proxy).toHaveBeenCalledTimes(1);
      expect(proxy).toHaveBeenCalledWith({
        endpoint: "/repos/test-org/test-repo/issues/42/comments",
        method: "POST",
        body: {
          body: "This is a review comment",
        },
      });
    });

    it("should handle multi-line comments", async () => {
      const multilineBody = "Line 1\nLine 2\n\n- Item 1\n- Item 2";
      await connector.addComment("test-org", "test-repo", 42, multilineBody);

      expect(proxy).toHaveBeenCalledWith({
        endpoint: "/repos/test-org/test-repo/issues/42/comments",
        method: "POST",
        body: {
          body: multilineBody,
        },
      });
    });
  });

  describe("Create issue", () => {
    it("should create a new issue and return NormalizedIssue", async () => {
      const issue = await connector.createIssue("test-org", "test-repo", {
        title: "New Issue Title",
        body: "New issue body",
      });

      expect(issue.id).toBe("100");
      expect(issue.title).toBe("New Issue Title");
      expect(issue.description).toBe("New issue body");
      expect(issue.status).toBe("open");
      expect(issue.provider_url).toBe("https://github.com/test-org/test-repo/issues/100");

      expect(proxy).toHaveBeenCalledTimes(1);
      expect(proxy).toHaveBeenCalledWith({
        endpoint: "/repos/test-org/test-repo/issues",
        method: "POST",
        body: {
          title: "New Issue Title",
          body: "New issue body",
        },
      });
    });

    it("should handle created issue with closed state", async () => {
      proxy = makeProxy({
        create: {
          number: 101,
          title: "Closed On Create",
          body: "Was immediately closed",
          state: "closed",
          html_url: "https://github.com/test-org/test-repo/issues/101",
        },
      });

      const closedConnector = new GitHubConnector({ proxy });
      const issue = await closedConnector.createIssue("test-org", "test-repo", {
        title: "Closed On Create",
        body: "Was immediately closed",
      });

      expect(issue.status).toBe("closed");
    });
  });

  describe("Full round-trip", () => {
    it("should hydrate, update, comment, and create in sequence", async () => {
      // Step 1: Hydrate existing issue
      const original = await connector.hydrateIssue("test-org", "test-repo", 42);
      expect(original.id).toBe("42");
      expect(original.title).toBe("Original Title");
      expect(original.status).toBe("open");

      // Step 2: Update the issue
      await connector.updateIssue("test-org", "test-repo", 42, {
        title: "Updated Title",
        state: "closed",
      });

      // Step 3: Add a comment
      await connector.addComment("test-org", "test-repo", 42, "Closing this issue after fix");

      // Step 4: Create a follow-up issue
      const followUp = await connector.createIssue("test-org", "test-repo", {
        title: "New Issue Title",
        body: "Follow-up to #42",
      });

      expect(followUp.id).toBe("100");
      expect(callsBy(proxy, isUpdate)).toHaveLength(1);
      expect(callsBy(proxy, isComment)).toHaveLength(1);
      expect(callsBy(proxy, isCreate)).toHaveLength(1);
    });

    it("should pass correct params throughout the round-trip", async () => {
      // Hydrate
      await connector.hydrateIssue("org1", "repo1", 10);
      expect(proxy).toHaveBeenCalledWith({
        endpoint: "/repos/org1/repo1/issues/10",
        method: "GET",
      });

      // Update
      await connector.updateIssue("org1", "repo1", 10, { title: "T" });
      expect(proxy).toHaveBeenCalledWith({
        endpoint: "/repos/org1/repo1/issues/10",
        method: "PATCH",
        body: { title: "T" },
      });

      // Comment
      await connector.addComment("org1", "repo1", 10, "Comment text");
      expect(proxy).toHaveBeenCalledWith({
        endpoint: "/repos/org1/repo1/issues/10/comments",
        method: "POST",
        body: { body: "Comment text" },
      });

      // Create
      await connector.createIssue("org1", "repo1", { title: "New", body: "Body" });
      expect(proxy).toHaveBeenCalledWith({
        endpoint: "/repos/org1/repo1/issues",
        method: "POST",
        body: { title: "New", body: "Body" },
      });
    });

    it("should handle multiple hydrations", async () => {
      await connector.hydrateIssue("org1", "repo1", 1);
      await connector.hydrateIssue("org1", "repo1", 2);
      await connector.hydrateIssue("org2", "repo2", 3);

      expect(callsBy(proxy, isGet)).toHaveLength(3);
    });
  });
});
