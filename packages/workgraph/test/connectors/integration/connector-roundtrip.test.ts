import { vi, describe, it, expect, beforeEach } from "vitest";
import { GitHubConnector, type NormalizedIssue } from "../../../src/connectors/github/github";

describe("GitHub Connector Round-Trip Integration", () => {
  let getMock: ReturnType<typeof mock>;
  let updateMock: ReturnType<typeof mock>;
  let createCommentMock: ReturnType<typeof mock>;
  let createMock: ReturnType<typeof mock>;
  let connector: GitHubConnector;

  beforeEach(() => {
    getMock = vi.fn(async () => ({
      data: {
        number: 42,
        title: "Original Title",
        body: "Original body content",
        state: "open",
        html_url: "https://github.com/test-org/test-repo/issues/42",
      },
    }));

    updateMock = vi.fn(async () => ({}));

    createCommentMock = vi.fn(async () => ({}));

    createMock = vi.fn(async () => ({
      data: {
        number: 100,
        title: "New Issue Title",
        body: "New issue body",
        state: "open",
        html_url: "https://github.com/test-org/test-repo/issues/100",
      },
    }));

    const mockOctokit = {
      rest: {
        issues: {
          get: getMock,
          update: updateMock,
          createComment: createCommentMock,
          create: createMock,
        },
      },
    };

    connector = new GitHubConnector(mockOctokit as any);
  });

  describe("Hydrate issue", () => {
    it("should hydrate an issue into NormalizedIssue model", async () => {
      const issue = await connector.hydrateIssue("test-org", "test-repo", 42);

      expect(issue.id).toBe("42");
      expect(issue.title).toBe("Original Title");
      expect(issue.description).toBe("Original body content");
      expect(issue.status).toBe("open");
      expect(issue.provider_url).toBe("https://github.com/test-org/test-repo/issues/42");

      expect(getMock).toHaveBeenCalledTimes(1);
      expect(getMock).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
      });
    });

    it("should map closed state correctly", async () => {
      getMock = vi.fn(async () => ({
        data: {
          number: 43,
          title: "Closed Issue",
          body: "This issue is closed",
          state: "closed",
          html_url: "https://github.com/test-org/test-repo/issues/43",
        },
      }));

      const mockOctokit = {
        rest: {
          issues: {
            get: getMock,
            update: updateMock,
            createComment: createCommentMock,
            create: createMock,
          },
        },
      };

      const closedConnector = new GitHubConnector(mockOctokit as any);
      const issue = await closedConnector.hydrateIssue("test-org", "test-repo", 43);

      expect(issue.status).toBe("closed");
    });

    it("should handle null body as empty string", async () => {
      getMock = vi.fn(async () => ({
        data: {
          number: 44,
          title: "No Body",
          body: null,
          state: "open",
          html_url: "https://github.com/test-org/test-repo/issues/44",
        },
      }));

      const mockOctokit = {
        rest: {
          issues: {
            get: getMock,
            update: updateMock,
            createComment: createCommentMock,
            create: createMock,
          },
        },
      };

      const noBodyConnector = new GitHubConnector(mockOctokit as any);
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

      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(updateMock).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        title: "Updated Title",
        state: "closed",
      });
    });

    it("should update only title", async () => {
      await connector.updateIssue("test-org", "test-repo", 42, {
        title: "New Title Only",
      });

      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(updateMock).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        title: "New Title Only",
      });
    });

    it("should update only state", async () => {
      await connector.updateIssue("test-org", "test-repo", 42, {
        state: "open",
      });

      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(updateMock).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        state: "open",
      });
    });
  });

  describe("Add comment", () => {
    it("should add a comment to an issue", async () => {
      await connector.addComment("test-org", "test-repo", 42, "This is a review comment");

      expect(createCommentMock).toHaveBeenCalledTimes(1);
      expect(createCommentMock).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body: "This is a review comment",
      });
    });

    it("should handle multi-line comments", async () => {
      const multilineBody = "Line 1\nLine 2\n\n- Item 1\n- Item 2";
      await connector.addComment("test-org", "test-repo", 42, multilineBody);

      expect(createCommentMock).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body: multilineBody,
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

      expect(createMock).toHaveBeenCalledTimes(1);
      expect(createMock).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        title: "New Issue Title",
        body: "New issue body",
      });
    });

    it("should handle created issue with closed state", async () => {
      createMock = vi.fn(async () => ({
        data: {
          number: 101,
          title: "Closed On Create",
          body: "Was immediately closed",
          state: "closed",
          html_url: "https://github.com/test-org/test-repo/issues/101",
        },
      }));

      const mockOctokit = {
        rest: {
          issues: {
            get: getMock,
            update: updateMock,
            createComment: createCommentMock,
            create: createMock,
          },
        },
      };

      const closedConnector = new GitHubConnector(mockOctokit as any);
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
      expect(followUp.title).toBe("New Issue Title");
      expect(followUp.status).toBe("open");

      // Verify all mocks were called
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(createCommentMock).toHaveBeenCalledTimes(1);
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    it("should pass correct params throughout the round-trip", async () => {
      // Hydrate
      await connector.hydrateIssue("org1", "repo1", 10);
      expect(getMock).toHaveBeenCalledWith({
        owner: "org1",
        repo: "repo1",
        issue_number: 10,
      });

      // Update
      await connector.updateIssue("org1", "repo1", 10, { title: "T" });
      expect(updateMock).toHaveBeenCalledWith({
        owner: "org1",
        repo: "repo1",
        issue_number: 10,
        title: "T",
      });

      // Comment
      await connector.addComment("org1", "repo1", 10, "Comment text");
      expect(createCommentMock).toHaveBeenCalledWith({
        owner: "org1",
        repo: "repo1",
        issue_number: 10,
        body: "Comment text",
      });

      // Create
      await connector.createIssue("org1", "repo1", { title: "New", body: "Body" });
      expect(createMock).toHaveBeenCalledWith({
        owner: "org1",
        repo: "repo1",
        title: "New",
        body: "Body",
      });
    });

    it("should handle multiple hydrations", async () => {
      await connector.hydrateIssue("org1", "repo1", 1);
      await connector.hydrateIssue("org1", "repo1", 2);
      await connector.hydrateIssue("org2", "repo2", 3);

      expect(getMock).toHaveBeenCalledTimes(3);
    });
  });
});
