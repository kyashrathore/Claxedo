/**
 * Batch Issues — Spawn parallel worktree agents
 *
 * Extracted handler logic for the batch_issues MCP tool.
 * Accepts a fetch function parameter for testability.
 *
 * Strategy: create all worktrees sequentially (git holds a repo-level lock
 * during `git worktree add`, so concurrent creates would serialize on the
 * lock anyway and risk failures), then start all agents in parallel.
 */

const MAX_ISSUES = 10
const BOOTSTRAP_TIMEOUT_MS = 60_000
const BOOTSTRAP_POLL_MS = 1_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BatchIssuesInput = {
  issues: Array<{ title: string; prompt: string }>
  agent: "opencode" | "claude" | "codex" | "aider"
  model?: string
  directory?: string
}

type HttpFn = (path: string, init?: RequestInit, mode?: "json" | "text", directory?: string) => Promise<any>
type SleepFn = (ms: number) => Promise<void>

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

type IssueResult = {
  title: string
  success: boolean
  sessionId?: string
  ptyId?: string
  worktreeDir?: string
  error?: string
  promptError?: string
}

type WorktreeEntry = {
  issue: { title: string; prompt: string }
  worktreeDir: string
}

// ---------------------------------------------------------------------------
// Agent command map for CLI agents
// ---------------------------------------------------------------------------

const AGENT_COMMANDS: Record<string, { command: string; buildArgs: (prompt: string) => string[] }> = {
  claude: { command: "claude", buildArgs: (p) => ["-p", p] },
  codex: { command: "codex", buildArgs: (p) => [p] },
  aider: { command: "aider", buildArgs: (p) => ["--message", p] },
}

// ---------------------------------------------------------------------------
// Helpers (mirrors claxedo-mcp.ts helpers for standalone use)
// ---------------------------------------------------------------------------

const clean = (value: unknown) => {
  if (typeof value !== "string") return ""
  return value.trim()
}

const splitModel = (value: string) => {
  const source = clean(value)
  const idx = source.indexOf("/")
  if (idx < 1 || idx >= source.length - 1) return undefined
  return {
    providerID: clean(source.slice(0, idx)),
    modelID: clean(source.slice(idx + 1)),
  }
}

export type TimingOverrides = {
  bootstrapTimeoutMs?: number
  bootstrapPollMs?: number
}

// ---------------------------------------------------------------------------
// Phase 1: Sequential worktree creation
// ---------------------------------------------------------------------------

async function createWorktrees(
  issues: Array<{ title: string; prompt: string }>,
  http: HttpFn,
  directory: string,
): Promise<{ created: WorktreeEntry[]; failed: IssueResult[] }> {
  const created: WorktreeEntry[] = []
  const failed: IssueResult[] = []

  for (const issue of issues) {
    try {
      const worktree = await http(
        "/experimental/worktree",
        { method: "POST", body: JSON.stringify({ name: issue.title }) },
        "json",
        directory,
      )
      created.push({ issue, worktreeDir: worktree.directory })
    } catch (err) {
      failed.push({
        title: issue.title,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { created, failed }
}

// ---------------------------------------------------------------------------
// Phase 2: Wait for worktree ready + start agent
// ---------------------------------------------------------------------------

async function waitForWorktreeReady(
  http: HttpFn,
  directory: string,
  sleepFn: SleepFn,
  opts: TimingOverrides,
) {
  const timeout = opts.bootstrapTimeoutMs ?? BOOTSTRAP_TIMEOUT_MS
  const poll = opts.bootstrapPollMs ?? BOOTSTRAP_POLL_MS
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    try {
      await http("/session", { method: "GET" }, "json", directory)
      return
    } catch {
      await sleepFn(poll)
    }
  }
  throw new Error(`Worktree bootstrap timed out after ${timeout}ms`)
}

async function startOpencodeAgent(
  entry: WorktreeEntry,
  http: HttpFn,
  sleepFn: SleepFn,
  model: { providerID: string; modelID: string } | undefined,
  opts: TimingOverrides,
): Promise<IssueResult> {
  const { issue, worktreeDir } = entry

  // Wait for worktree server to be ready
  try {
    await waitForWorktreeReady(http, worktreeDir, sleepFn, opts)
  } catch (err) {
    return {
      title: issue.title,
      success: false,
      worktreeDir,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Create session
  let sessionId: string
  try {
    const session = await http(
      "/session",
      { method: "POST", body: JSON.stringify({ title: issue.title }) },
      "json",
      worktreeDir,
    )
    sessionId = session.id
  } catch (err) {
    return {
      title: issue.title,
      success: false,
      worktreeDir,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Send prompt_async (fire-and-forget — failure doesn't prevent success)
  let promptError: string | undefined
  try {
    const promptBody: Record<string, unknown> = {
      parts: [{ type: "text", text: issue.prompt }],
    }
    if (model) {
      promptBody.model = model
    }
    await http(
      `/session/${sessionId}/prompt_async`,
      { method: "POST", body: JSON.stringify(promptBody) },
      "json",
      worktreeDir,
    )
  } catch (err) {
    promptError = err instanceof Error ? err.message : String(err)
  }

  return { title: issue.title, success: true, sessionId, worktreeDir, promptError }
}

async function startCliAgent(
  entry: WorktreeEntry,
  http: HttpFn,
  sleepFn: SleepFn,
  agent: string,
  opts: TimingOverrides,
): Promise<IssueResult> {
  const { issue, worktreeDir } = entry
  const agentConfig = AGENT_COMMANDS[agent]
  if (!agentConfig) {
    return { title: issue.title, success: false, error: `Unknown CLI agent: ${agent}` }
  }

  // Wait for worktree server to be ready
  try {
    await waitForWorktreeReady(http, worktreeDir, sleepFn, opts)
  } catch (err) {
    return {
      title: issue.title,
      success: false,
      worktreeDir,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Create PTY with CLI agent command
  try {
    const ptyResult = await http(
      "/pty",
      {
        method: "POST",
        body: JSON.stringify({
          command: agentConfig.command,
          args: agentConfig.buildArgs(issue.prompt),
          cwd: worktreeDir,
          title: `${agent}: ${issue.title}`,
        }),
      },
      "json",
      worktreeDir,
    )
    return { title: issue.title, success: true, ptyId: ptyResult.id, worktreeDir }
  } catch (err) {
    return {
      title: issue.title,
      success: false,
      worktreeDir,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

export async function handleBatchIssues(
  args: BatchIssuesInput,
  http: HttpFn,
  sleepFn: SleepFn,
  timingOverrides: TimingOverrides = {},
): Promise<ToolResult> {
  const directory = clean(args.directory) || (process.env.OPENCODE_API_DIR || process.cwd())
  const issues = args.issues.slice(0, MAX_ISSUES)
  const agent = args.agent || "opencode"

  // Parse model if provided
  let model: { providerID: string; modelID: string } | undefined
  if (args.model) {
    model = splitModel(args.model)
  }

  const isOpencode = agent === "opencode"

  // Phase 1: Create all worktrees sequentially (git lock prevents true parallelism)
  const { created, failed } = await createWorktrees(issues, http, directory)

  // Phase 2: Start all agents in parallel (worktrees are independent once created)
  const agentResults = await Promise.allSettled(
    created.map((entry) =>
      isOpencode
        ? startOpencodeAgent(entry, http, sleepFn, model, timingOverrides)
        : startCliAgent(entry, http, sleepFn, agent, timingOverrides),
    ),
  )

  // Collect results
  const issueResults: IssueResult[] = [
    ...failed,
    ...agentResults.map((r, i) => {
      if (r.status === "fulfilled") return r.value
      return {
        title: created[i].issue.title,
        success: false,
        worktreeDir: created[i].worktreeDir,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      }
    }),
  ]

  const succeeded = issueResults.filter((r) => r.success)
  const allFailed = issueResults.filter((r) => !r.success)

  // Build summary
  const lines: string[] = []
  lines.push(`Batch issues: ${succeeded.length}/${issueResults.length} succeeded`)
  lines.push("")

  for (const r of succeeded) {
    if (isOpencode) {
      lines.push(`✓ "${r.title}" → session ${r.sessionId} (${r.worktreeDir})`)
      if (r.promptError) lines.push(`  ⚠ prompt send failed: ${r.promptError}`)
    } else {
      lines.push(`✓ "${r.title}" → pty ${r.ptyId} (${r.worktreeDir})`)
    }
  }

  for (const r of allFailed) {
    lines.push(`✗ "${r.title}" → ${r.error}`)
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    ...(succeeded.length === 0 ? { isError: true } : {}),
  }
}
