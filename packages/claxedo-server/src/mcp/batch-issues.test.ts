/**
 * Batch Issues MCP Tool Tests
 *
 * Tests the batch_issues handler logic that spawns parallel worktrees,
 * each with its own agent (opencode session or CLI agent in PTY).
 */
import { describe, test, expect, beforeEach } from "bun:test"
import { handleBatchIssues, type BatchIssuesInput } from "./batch-issues"

// ---------------------------------------------------------------------------
// Mock HTTP infrastructure
// ---------------------------------------------------------------------------

type HttpCall = {
  path: string
  init?: RequestInit
  mode?: string
  directory?: string
}

function createMockHttp() {
  const calls: HttpCall[] = []
  const responses = new Map<string, any>()

  const httpFn = async (path: string, init?: RequestInit, mode?: string, directory?: string) => {
    calls.push({ path, init, mode, directory })

    // Match response by path pattern
    if (path.startsWith("/experimental/worktree") && init?.method === "POST") {
      const key = `worktree-create`
      if (responses.has(key)) return responses.get(key)
      return { name: "test-sandbox", branch: "test-branch", directory: "/worktrees/test-sandbox" }
    }
    if (path === "/session" && init?.method === "GET") {
      const key = `session-list-${directory}`
      if (responses.has(key)) return responses.get(key)
      return [{ id: "session_existing", title: "Existing" }]
    }
    if (path === "/session" && init?.method === "POST") {
      const key = `session-create-${directory}`
      if (responses.has(key)) return responses.get(key)
      return { id: `session_new_${Date.now()}`, title: "New Session" }
    }
    if (path.includes("/prompt_async")) {
      return undefined
    }
    if (path === "/pty" && init?.method === "POST") {
      const key = `pty-create-${directory}`
      if (responses.has(key)) return responses.get(key)
      return { id: `pty_${Date.now()}`, title: "Agent PTY", status: "running" }
    }
    if (path === "/provider" && init?.method === "GET") {
      return { all: [{ id: "anthropic", models: { "claude-sonnet-4": { id: "claude-sonnet-4" } } }] }
    }
    throw new Error(`Unmocked path: ${path}`)
  }

  return { calls, responses, httpFn: httpFn as any }
}

// Instant sleep for tests
const instantSleep = () => Promise.resolve()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<BatchIssuesInput> = {}): BatchIssuesInput {
  return {
    issues: [
      { title: "Fix login bug", prompt: "The login form crashes on submit" },
      { title: "Add dark mode", prompt: "Implement dark mode toggle" },
    ],
    agent: "opencode",
    ...overrides,
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe("batch_issues", () => {
  let mockHttp: ReturnType<typeof createMockHttp>

  beforeEach(() => {
    mockHttp = createMockHttp()
  })

  // -------------------------------------------------------------------------
  // opencode mode
  // -------------------------------------------------------------------------
  describe("opencode mode", () => {
    test("creates worktree for each issue", async () => {
      const result = await handleBatchIssues(makeInput(), mockHttp.httpFn, instantSleep)

      const worktreeCalls = mockHttp.calls.filter(
        (c) => c.path === "/experimental/worktree" && c.init?.method === "POST",
      )
      expect(worktreeCalls).toHaveLength(2)

      // Verify worktree names come from issue titles
      const bodies = worktreeCalls.map((c) => JSON.parse(c.init!.body as string))
      expect(bodies[0].name).toBe("Fix login bug")
      expect(bodies[1].name).toBe("Add dark mode")
    })

    test("polls until worktree is ready", async () => {
      let sessionCallCount = 0
      const originalHttp = mockHttp.httpFn
      mockHttp.httpFn = async (path: string, init?: RequestInit, mode?: string, directory?: string) => {
        if (path === "/session" && init?.method === "GET") {
          sessionCallCount++
          if (sessionCallCount <= 2) throw new Error("Not ready yet")
          return [{ id: "session_ready", title: "Ready" }]
        }
        return originalHttp(path, init, mode, directory)
      }

      const result = await handleBatchIssues(
        makeInput({ issues: [{ title: "Bug", prompt: "Fix it" }] }),
        mockHttp.httpFn,
        instantSleep,
      )

      expect(sessionCallCount).toBeGreaterThan(2)
      expect(result.isError).toBeFalsy()
    })

    test("creates session scoped to worktree directory", async () => {
      await handleBatchIssues(makeInput(), mockHttp.httpFn, instantSleep)

      const sessionCreateCalls = mockHttp.calls.filter((c) => c.path === "/session" && c.init?.method === "POST")
      expect(sessionCreateCalls).toHaveLength(2)

      // Each session creation should target the worktree directory
      for (const call of sessionCreateCalls) {
        expect(call.directory).toBe("/worktrees/test-sandbox")
      }
    })

    test("sends prompt_async with issue prompt text", async () => {
      mockHttp.responses.set("session-create-/worktrees/test-sandbox", {
        id: "session_abc",
        title: "New",
      })

      await handleBatchIssues(
        makeInput({ issues: [{ title: "Bug", prompt: "Fix the crash" }] }),
        mockHttp.httpFn,
        instantSleep,
      )

      const promptCalls = mockHttp.calls.filter((c) => c.path.includes("/prompt_async"))
      expect(promptCalls).toHaveLength(1)
      expect(promptCalls[0].path).toBe("/session/session_abc/prompt_async")

      const body = JSON.parse(promptCalls[0].init!.body as string)
      expect(body.parts[0].text).toContain("Fix the crash")
    })

    test("validates and passes model override when provided", async () => {
      await handleBatchIssues(
        makeInput({
          issues: [{ title: "Bug", prompt: "Fix it" }],
          model: "anthropic/claude-sonnet-4",
        }),
        mockHttp.httpFn,
        instantSleep,
      )

      const promptCalls = mockHttp.calls.filter((c) => c.path.includes("/prompt_async"))
      expect(promptCalls).toHaveLength(1)
      const body = JSON.parse(promptCalls[0].init!.body as string)
      expect(body.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
    })

    test("returns summary with all session IDs", async () => {
      let counter = 0
      const originalHttp = mockHttp.httpFn
      mockHttp.httpFn = async (path: string, init?: RequestInit, mode?: string, directory?: string) => {
        if (path === "/session" && init?.method === "POST") {
          counter++
          return { id: `session_${counter}`, title: `Session ${counter}` }
        }
        return originalHttp(path, init, mode, directory)
      }

      const result = await handleBatchIssues(makeInput(), mockHttp.httpFn, instantSleep)

      expect(result.isError).toBeFalsy()
      const text = result.content[0].text
      expect(text).toContain("session_1")
      expect(text).toContain("session_2")
      expect(text).toContain("2/2")
    })

    test("handles partial failure (one issue fails, others succeed)", async () => {
      let worktreeCount = 0
      const originalHttp = mockHttp.httpFn
      mockHttp.httpFn = async (path: string, init?: RequestInit, mode?: string, directory?: string) => {
        if (path === "/experimental/worktree" && init?.method === "POST") {
          worktreeCount++
          if (worktreeCount === 1) throw new Error("Disk full")
          return { name: "sandbox-2", branch: "branch-2", directory: "/worktrees/sandbox-2" }
        }
        return originalHttp(path, init, mode, directory)
      }

      const result = await handleBatchIssues(makeInput(), mockHttp.httpFn, instantSleep)

      expect(result.isError).toBeFalsy()
      const text = result.content[0].text
      expect(text).toContain("1/2")
      expect(text).toContain("Disk full")
    })
  })

  // -------------------------------------------------------------------------
  // CLI agent mode
  // -------------------------------------------------------------------------
  describe("CLI agent mode (claude/codex/aider)", () => {
    test("creates worktree for each issue", async () => {
      await handleBatchIssues(makeInput({ agent: "claude" }), mockHttp.httpFn, instantSleep)

      const worktreeCalls = mockHttp.calls.filter(
        (c) => c.path === "/experimental/worktree" && c.init?.method === "POST",
      )
      expect(worktreeCalls).toHaveLength(2)
    })

    test("creates PTY with correct command for claude", async () => {
      await handleBatchIssues(
        makeInput({ agent: "claude", issues: [{ title: "Bug", prompt: "Fix it" }] }),
        mockHttp.httpFn,
        instantSleep,
      )

      const ptyCalls = mockHttp.calls.filter((c) => c.path === "/pty" && c.init?.method === "POST")
      expect(ptyCalls).toHaveLength(1)

      const body = JSON.parse(ptyCalls[0].init!.body as string)
      expect(body.command).toBe("claude")
      expect(body.args).toEqual(["-p", "Fix it"])
    })

    test("creates PTY with correct command for codex", async () => {
      await handleBatchIssues(
        makeInput({ agent: "codex", issues: [{ title: "Bug", prompt: "Fix it" }] }),
        mockHttp.httpFn,
        instantSleep,
      )

      const ptyCalls = mockHttp.calls.filter((c) => c.path === "/pty" && c.init?.method === "POST")
      const body = JSON.parse(ptyCalls[0].init!.body as string)
      expect(body.command).toBe("codex")
      expect(body.args).toEqual(["Fix it"])
    })

    test("creates PTY with correct command for aider", async () => {
      await handleBatchIssues(
        makeInput({ agent: "aider", issues: [{ title: "Bug", prompt: "Fix it" }] }),
        mockHttp.httpFn,
        instantSleep,
      )

      const ptyCalls = mockHttp.calls.filter((c) => c.path === "/pty" && c.init?.method === "POST")
      const body = JSON.parse(ptyCalls[0].init!.body as string)
      expect(body.command).toBe("aider")
      expect(body.args).toEqual(["--message", "Fix it"])
    })

    test("passes cwd as worktree directory", async () => {
      await handleBatchIssues(
        makeInput({ agent: "claude", issues: [{ title: "Bug", prompt: "Fix" }] }),
        mockHttp.httpFn,
        instantSleep,
      )

      const ptyCalls = mockHttp.calls.filter((c) => c.path === "/pty" && c.init?.method === "POST")
      const body = JSON.parse(ptyCalls[0].init!.body as string)
      expect(body.cwd).toBe("/worktrees/test-sandbox")
    })

    test("sets PTY title to 'agent: issue.title'", async () => {
      await handleBatchIssues(
        makeInput({ agent: "claude", issues: [{ title: "Fix login bug", prompt: "Fix" }] }),
        mockHttp.httpFn,
        instantSleep,
      )

      const ptyCalls = mockHttp.calls.filter((c) => c.path === "/pty" && c.init?.method === "POST")
      const body = JSON.parse(ptyCalls[0].init!.body as string)
      expect(body.title).toBe("claude: Fix login bug")
    })

    test("returns summary with all PTY IDs", async () => {
      let counter = 0
      const originalHttp = mockHttp.httpFn
      mockHttp.httpFn = async (path: string, init?: RequestInit, mode?: string, directory?: string) => {
        if (path === "/pty" && init?.method === "POST") {
          counter++
          return { id: `pty_${counter}`, title: `PTY ${counter}`, status: "running" }
        }
        return originalHttp(path, init, mode, directory)
      }

      const result = await handleBatchIssues(makeInput({ agent: "claude" }), mockHttp.httpFn, instantSleep)

      expect(result.isError).toBeFalsy()
      const text = result.content[0].text
      expect(text).toContain("pty_1")
      expect(text).toContain("pty_2")
      expect(text).toContain("2/2")
    })
  })

  // -------------------------------------------------------------------------
  // error handling
  // -------------------------------------------------------------------------
  describe("error handling", () => {
    test("worktree creation failure → reports error, continues others", async () => {
      let worktreeCount = 0
      const originalHttp = mockHttp.httpFn
      mockHttp.httpFn = async (path: string, init?: RequestInit, mode?: string, directory?: string) => {
        if (path === "/experimental/worktree" && init?.method === "POST") {
          worktreeCount++
          if (worktreeCount === 1) throw new Error("Git error: branch exists")
          return { name: "sandbox-2", branch: "branch-2", directory: "/worktrees/sandbox-2" }
        }
        return originalHttp(path, init, mode, directory)
      }

      const result = await handleBatchIssues(makeInput(), mockHttp.httpFn, instantSleep)

      const text = result.content[0].text
      expect(text).toContain("Git error: branch exists")
      expect(text).toContain("1/2")
    })

    test("worktree bootstrap timeout → reports error", async () => {
      const originalHttp = mockHttp.httpFn
      mockHttp.httpFn = async (path: string, init?: RequestInit, mode?: string, directory?: string) => {
        if (path === "/session" && init?.method === "GET") {
          throw new Error("Not ready")
        }
        return originalHttp(path, init, mode, directory)
      }

      const result = await handleBatchIssues(
        makeInput({ issues: [{ title: "Bug", prompt: "Fix" }] }),
        mockHttp.httpFn,
        instantSleep,
        { bootstrapTimeoutMs: 50, bootstrapPollMs: 10 },
      )

      const text = result.content[0].text
      expect(text).toContain("timed out")
    })

    test("session creation failure → reports error", async () => {
      const originalHttp = mockHttp.httpFn
      mockHttp.httpFn = async (path: string, init?: RequestInit, mode?: string, directory?: string) => {
        if (path === "/session" && init?.method === "POST") {
          throw new Error("Session limit reached")
        }
        return originalHttp(path, init, mode, directory)
      }

      const result = await handleBatchIssues(
        makeInput({ issues: [{ title: "Bug", prompt: "Fix" }] }),
        mockHttp.httpFn,
        instantSleep,
      )

      const text = result.content[0].text
      expect(text).toContain("Session limit reached")
    })

    test("prompt_async failure → still reports session as created", async () => {
      const originalHttp = mockHttp.httpFn
      mockHttp.httpFn = async (path: string, init?: RequestInit, mode?: string, directory?: string) => {
        if (path.includes("/prompt_async")) {
          throw new Error("Prompt failed")
        }
        if (path === "/session" && init?.method === "POST") {
          return { id: "session_ok", title: "OK" }
        }
        return originalHttp(path, init, mode, directory)
      }

      const result = await handleBatchIssues(
        makeInput({ issues: [{ title: "Bug", prompt: "Fix" }] }),
        mockHttp.httpFn,
        instantSleep,
      )

      const text = result.content[0].text
      // Session was created — it should still be reported as a success
      expect(text).toContain("session_ok")
      expect(text).toContain("1/1")
    })

    test("PTY creation failure → reports error", async () => {
      const originalHttp = mockHttp.httpFn
      mockHttp.httpFn = async (path: string, init?: RequestInit, mode?: string, directory?: string) => {
        if (path === "/pty" && init?.method === "POST") {
          throw new Error("PTY limit exceeded")
        }
        return originalHttp(path, init, mode, directory)
      }

      const result = await handleBatchIssues(
        makeInput({ agent: "claude", issues: [{ title: "Bug", prompt: "Fix" }] }),
        mockHttp.httpFn,
        instantSleep,
      )

      const text = result.content[0].text
      expect(text).toContain("PTY limit exceeded")
    })

    test("returns isError when all issues fail", async () => {
      const originalHttp = mockHttp.httpFn
      mockHttp.httpFn = async (path: string, init?: RequestInit, mode?: string, directory?: string) => {
        if (path === "/experimental/worktree") {
          throw new Error("All fail")
        }
        return originalHttp(path, init, mode, directory)
      }

      const result = await handleBatchIssues(makeInput(), mockHttp.httpFn, instantSleep)

      expect(result.isError).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // input validation
  // -------------------------------------------------------------------------
  describe("input validation", () => {
    test("uses clean(directory) or DEFAULT_DIR", async () => {
      await handleBatchIssues(
        makeInput({ directory: "  /my/project  ", issues: [{ title: "Bug", prompt: "Fix" }] }),
        mockHttp.httpFn,
        instantSleep,
      )

      const worktreeCall = mockHttp.calls.find(
        (c) => c.path === "/experimental/worktree" && c.init?.method === "POST",
      )
      expect(worktreeCall!.directory).toBe("/my/project")
    })

    test("limits to max 10 issues", async () => {
      const issues = Array.from({ length: 15 }, (_, i) => ({
        title: `Issue ${i}`,
        prompt: `Fix issue ${i}`,
      }))

      const result = await handleBatchIssues(makeInput({ issues }), mockHttp.httpFn, instantSleep)

      const worktreeCalls = mockHttp.calls.filter(
        (c) => c.path === "/experimental/worktree" && c.init?.method === "POST",
      )
      expect(worktreeCalls).toHaveLength(10)
    })
  })
})
