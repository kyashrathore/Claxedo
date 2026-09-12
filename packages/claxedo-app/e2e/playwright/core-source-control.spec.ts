/**
 * The workspace panel's Changes navigator is `SourceControlView`: the header trio's
 * Changes opens the panel with the commit box, Publish / Push and Create PR, the Staged
 * Changes and Changes groups and the Graph in the panel's files column, beside the Review
 * tab. A row click focuses that file's diff in the Review tab in the row's mode.
 *
 * The view reads the workspace-runtime `/api/wr/git/status` and `/api/wr/git/log` routes
 * and writes through `/api/wr/git/{stage,unstage,commit-staged,push}`. The shared mock
 * serves none of the six, so `installGitFixture` answers them from one in-memory repo whose
 * staged and unstaged lists, commits and upstream the writes mutate, the way `git` would.
 * The Review tab reads the workspace-runtime `/api/wr/diff/vcs` routes and the OpenCode
 * `/file/status` summary; both are seeded here from the same files so the file the user
 * clicks in Changes is the file the review focuses. A `to-from` read is answered from
 * `COMPARE_DIFFS` by its `fromRef..toRef` pair: the seeded branch against HEAD, and each
 * seeded commit against its parent (the empty tree for the root), which is what the
 * compare pill, the Compared changes group and a graph commit click request. The pill's
 * ref list comes from `/api/wr/diff/refs`, served here as `SEEDED_REFS`.
 *
 * Create PR reads the workspace's remote from the project catalog (`GET /project`,
 * `useWorkspaceRemoteUrl`), which the shared mock serves without a remote; the scenarios
 * that need one serve the project row with a `git.remote` of their own.
 *
 * The full-view scenario maximizes the panel over the pane column: the focused session
 * floats over it and keeps its history behind a two-step reveal. The whole transcript
 * sits collapsed under a peek strip (`session-transcript-peek`, count = every visible
 * turn), and once peeked the history window still holds only the last turn, with the
 * in-timeline `timeline-previous-messages` row counting the turns above it. The collapsed
 * transcript is `max-height: 0`, so its virtualized rows do not exist in the DOM until the
 * peek. Every session route is overridden after `installMockRuntime` (Playwright matches
 * the most recently registered route first) with four settled turns, because the floating
 * window opens at one turn and the reveal row exists only when there is history behind it.
 * Every pattern ends in `**` or has a `?**` twin: without one Playwright demands an exact
 * end-of-URL match and the app's `?directory=` suffix makes it miss silently.
 *
 * The classic panel's rendered width is the panel's own `defaultWidth()` (70% of the
 * column) rather than a stored number, so the docked assertions are on the shape (a px
 * panel narrower than `main`, the navigator column inside it) and not on a number.
 *
 * The rail reads `/api/control/session-list` (loopback spelling `/api/claxedo/session-list`),
 * which the shared mock answers EMPTY; one row for `SESSION_ID` is served here in the
 * shape `core-sidebar-tree.spec.ts` uses so the rail oracle has a row to name.
 */
import { writeFile } from "node:fs/promises"
import { expect, test, type Locator, type Page, type Route, type TestInfo } from "@playwright/test"
// CONTRACT BINDING: the row and commit shapes `GET /api/wr/git/status` and `/log` return.
import type { GitCommitSummary, GitStatusEntry } from "../../../workspace-runtime/src/workspace-files/git-worktree"
import { sessionListRoute } from "../helpers/contracts/session-list"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectRailRowVisible } from "../helpers/rail-oracle"
import { captureEvidence } from "../helpers/visual-evidence"

const DIR = "/tmp/e2e-core-source-control"
const PROJECT_ID = "proj_core_source_control"
const SESSION_ID = "ses_core_source_control_mock"
const SPEC = "core-source-control"
const TURNS = 4
const FOCUS_FILE = "src/index.ts"

/** The full-view panel and the docked px panel are far apart, so a few px of border
 * or subpixel rounding can never blur the two. */
const WIDTH_TOLERANCE = 4
/** `minWidth` in `workspace-panel.tsx`: the narrowest px panel the docked layout renders. */
const CLASSIC_PANEL_MIN_WIDTH = 360

const DEFAULT_BRANCH = "main"
/** Off the default branch, with a `/` so the compare URL's encoding is exercised. */
const FEATURE_BRANCH = "feat/source-control"
const GITHUB_REMOTE = "git@github.com:acme/app.git"
const GITLAB_REMOTE = "git@gitlab.com:acme/app.git"
const PUSH_REJECTION = "remote: rejected"

const STAGED_FILE = FOCUS_FILE
const UNSTAGED_FILE = "src/util.ts"
const DELETED_FILE = "README.md"
const UNTRACKED_FILE = "docs/notes.md"

/** The branch the compare scenarios pick; `seeded` is in no branch name, so it matches only commit subjects. */
const COMPARE_BRANCH = "feat/compare"
const COMPARE_FILE = "src/compare.ts"
/** In no worktree group, so a compare row's path never matches a Changes row. */
const COMPARE_DOC = "docs/compare.md"
const SECOND_COMMIT_FILE = "src/second.ts"
const FIRST_COMMIT_FILE = "src/first.ts"
/** git's hash of the empty tree, the base the app compares a root commit against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

function seededHash(n: number) {
  return n.toString(16).padStart(2, "0").repeat(20)
}

function seededCommit(n: number, subject: string, refs: string[], parents: string[]): GitCommitSummary {
  const hash = seededHash(n)
  return {
    hash,
    shortHash: hash.slice(0, 7),
    subject,
    author: "E2E Author",
    date: new Date(Date.now() - n * 3_600_000).toISOString(),
    refs,
    parents,
  }
}

/** One staged file, two unstaged, one untracked, on a branch with no upstream. */
const SEEDED_GIT = {
  branch: DEFAULT_BRANCH,
  staged: [{ path: STAGED_FILE, status: "modified", additions: 1, deletions: 1 }],
  unstaged: [
    { path: UNSTAGED_FILE, status: "modified", additions: 2, deletions: 0 },
    { path: DELETED_FILE, status: "deleted", additions: 0, deletions: 4 },
    { path: UNTRACKED_FILE, status: "untracked", additions: 3, deletions: 0 },
  ],
  commits: [
    seededCommit(2, "feat: second seeded commit", [`HEAD -> ${DEFAULT_BRANCH}`], [seededHash(1)]),
    seededCommit(1, "chore: first seeded commit", [], []),
  ],
} satisfies Pick<GitFixtureSeed, "branch" | "staged" | "unstaged" | "commits">

/** The Review tab's summary reads OpenCode `/file/status`, which knows no untracked state. */
const SEEDED_STATUS = [...SEEDED_GIT.staged, ...SEEDED_GIT.unstaged].map((entry) => ({
  path: entry.path,
  status: entry.status === "untracked" ? "added" : entry.status,
  added: entry.additions,
  removed: entry.deletions,
}))

const SEEDED_DIFFS = [
  {
    file: FOCUS_FILE,
    status: "modified",
    additions: 1,
    deletions: 1,
    before: "export const ready = false\n",
    after: "export const ready = true\n",
    patch: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const ready = false\n+export const ready = true\n",
  },
  {
    file: "src/util.ts",
    status: "added",
    additions: 2,
    deletions: 0,
    before: "",
    after: "export function noop() {}\nexport const two = 2\n",
    patch: "--- /dev/null\n+++ b/src/util.ts\n@@ -0,0 +1,2 @@\n+export function noop() {}\n+export const two = 2\n",
  },
  {
    file: DELETED_FILE,
    status: "deleted",
    additions: 0,
    deletions: 4,
    before: "# app\n\nA seeded readme.\n\n",
    after: "",
    patch: "--- a/README.md\n+++ /dev/null\n@@ -1,4 +0,0 @@\n-# app\n-\n-A seeded readme.\n-\n",
  },
  {
    file: UNTRACKED_FILE,
    status: "added",
    additions: 3,
    deletions: 0,
    before: "",
    after: "one\ntwo\nthree\n",
    patch: "--- /dev/null\n+++ b/docs/notes.md\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n",
  },
]

const SEEDED_REFS = {
  branches: [DEFAULT_BRANCH, COMPARE_BRANCH, `origin/${DEFAULT_BRANCH}`],
  tags: ["v1.0.0"],
  recent: SEEDED_GIT.commits.map((commit) => ({ hash: commit.hash, subject: commit.subject })),
}

function addedDiff(file: string, lines: string[]) {
  return {
    file,
    status: "added",
    additions: lines.length,
    deletions: 0,
    before: "",
    after: `${lines.join("\n")}\n`,
    patch: `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`,
  }
}

/** Every `to-from` summary the scenarios request, by `fromRef..toRef`. */
const COMPARE_DIFFS: Record<string, ReturnType<typeof addedDiff>[]> = {
  [`${COMPARE_BRANCH}..HEAD`]: [addedDiff(COMPARE_FILE, ["export const compared = true", "export const again = 2"]), addedDiff(COMPARE_DOC, ["one"])],
  [`${seededHash(1)}..${seededHash(2)}`]: [addedDiff(SECOND_COMMIT_FILE, ["export const second = 2"])],
  [`${EMPTY_TREE}..${seededHash(1)}`]: [addedDiff(FIRST_COMMIT_FILE, ["export const first = 1"])],
}

function seededDiffsFor(params: URLSearchParams) {
  if (params.get("mode") !== "to-from") return SEEDED_DIFFS
  return COMPARE_DIFFS[`${params.get("fromRef")}..${params.get("toRef")}`] ?? []
}

type GitFixtureSeed = {
  branch: string
  upstream?: string
  ahead?: number
  behind?: number
  staged: readonly GitStatusEntry[]
  unstaged: readonly GitStatusEntry[]
  commits: readonly GitCommitSummary[]
  /** When set, every push is refused the way the runtime maps a rejected push: 502 `git_push_rejected` carrying git's stderr. */
  pushRejected?: string
}

type GitRequest = {
  method: string
  route: string
  url: string
  /** The worktree the request scoped itself to, by `?directory=` or the `x-claxedo-directory` header. */
  directory: string | undefined
  body?: unknown
}

type GitFixture = {
  /** The repo as `GET /api/wr/git/status` reports it now. */
  status(): { branch: string; upstream?: string; ahead: number; behind: number; staged: GitStatusEntry[]; unstaged: GitStatusEntry[] }
  /** Newest first, as `GET /api/wr/git/log` reports it now. */
  commits(): GitCommitSummary[]
  requests: GitRequest[]
}

function isApiRequest(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr"
}

function json(body: string) {
  return { status: 200, contentType: "application/json", body }
}

/**
 * The six `/api/wr/git/*` routes over one in-memory repo. Stage moves an entry from
 * `unstaged` to `staged` (an untracked file becomes `added`), unstage the reverse, a
 * commit consumes the staged list and becomes the new head with the `HEAD -> branch`
 * ref, and a push sets the upstream and clears `ahead`. Failures use the runtime's
 * codes and status numbers (`routes/git-worktree.ts` ERROR_STATUS).
 */
async function installGitFixture(page: Page, seed: GitFixtureSeed): Promise<GitFixture> {
  const repo = {
    branch: seed.branch,
    upstream: seed.upstream,
    ahead: seed.ahead ?? 0,
    behind: seed.behind ?? 0,
    staged: seed.staged.map((entry) => ({ ...entry })),
    unstaged: seed.unstaged.map((entry) => ({ ...entry })),
    commits: seed.commits.map((commit) => ({ ...commit, refs: [...commit.refs], parents: [...commit.parents] })),
  }
  const requests: GitRequest[] = []
  let sequence = 0
  const byPath = (a: GitStatusEntry, b: GitStatusEntry) => a.path.localeCompare(b.path)
  const status = () => ({
    branch: repo.branch,
    ...(repo.upstream ? { upstream: repo.upstream } : {}),
    ahead: repo.ahead,
    behind: repo.behind,
    staged: [...repo.staged].sort(byPath),
    unstaged: [...repo.unstaged].sort(byPath),
  })
  const move = (from: GitStatusEntry[], to: GitStatusEntry[], paths: string[], status: (entry: GitStatusEntry) => GitStatusEntry["status"]) => {
    for (const path of paths) {
      const index = from.findIndex((entry) => entry.path === path)
      if (index < 0) continue
      const [entry] = from.splice(index, 1)
      const kept = to.filter((existing) => existing.path !== path)
      to.splice(0, to.length, ...kept, { ...entry, status: status(entry) })
    }
  }
  const stage = (paths: string[]) =>
    move(repo.unstaged, repo.staged, paths, (entry) => (entry.status === "untracked" ? "added" : entry.status))
  const unstage = (paths: string[]) =>
    move(repo.staged, repo.unstaged, paths, (entry) => (entry.status === "added" ? "untracked" : entry.status))
  const commit = (message: string, amend: boolean) => {
    sequence += 1
    const hash = seededHash(0x60 + sequence)
    const head = repo.commits[0]
    if (head) head.refs = head.refs.filter((ref) => !ref.startsWith("HEAD"))
    const created: GitCommitSummary = {
      hash,
      shortHash: hash.slice(0, 7),
      subject: message.trim().split("\n")[0],
      author: "E2E Author",
      date: new Date().toISOString(),
      refs: [`HEAD -> ${repo.branch}`],
      parents: amend ? head?.parents ?? [] : head ? [head.hash] : [],
    }
    if (amend) repo.commits.shift()
    repo.commits.unshift(created)
    repo.staged = []
    if (repo.upstream) repo.ahead += 1
    return hash
  }

  await page.route("**/api/wr/git/**", async (route) => {
    if (!isApiRequest(route)) return route.continue()
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const name = url.pathname.replace(/^\/workspaces\/[^/]+/, "").replace(/^\/api\/wr\/git\//, "")
    let body: unknown
    if (method === "POST") {
      try {
        body = request.postDataJSON()
      } catch {
        body = request.postData()
      }
    }
    requests.push({
      method,
      route: name,
      url: request.url(),
      directory: url.searchParams.get("directory") ?? request.headers()["x-claxedo-directory"],
      ...(body === undefined ? {} : { body }),
    })
    const reply = (status: number, payload?: unknown) =>
      route.fulfill(payload === undefined ? { status, body: "" } : { status, contentType: "application/json", body: JSON.stringify(payload) })
    const refuse = (status: number, code: string, message: string) => reply(status, { error: { code, message } })

    if (method === "GET" && name === "status") return reply(200, status())
    if (method === "GET" && name === "log") {
      const limit = Number(url.searchParams.get("limit") ?? "50") || 50
      return reply(200, { commits: repo.commits.slice(0, limit) })
    }
    if (method !== "POST") return route.fallback()
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const paths = Array.isArray(record.paths) ? record.paths.filter((path): path is string => typeof path === "string") : []
    switch (name) {
      case "stage":
        stage(paths)
        return reply(204)
      case "unstage":
        unstage(paths)
        return reply(204)
      case "commit-staged": {
        const message = typeof record.message === "string" ? record.message : ""
        const amend = record.amend === true
        if (!message.trim()) return refuse(400, "git_empty_message", "Aborting commit due to empty commit message.")
        if (repo.staged.length === 0 && !amend) return refuse(400, "git_nothing_staged", "no changes added to commit")
        return reply(200, { commit: commit(message, amend) })
      }
      case "push": {
        if (seed.pushRejected) return refuse(502, "git_push_rejected", seed.pushRejected)
        repo.upstream = `origin/${repo.branch}`
        repo.ahead = 0
        return reply(200, { remote: "origin", branch: repo.branch })
      }
      default:
        return route.fallback()
    }
  })

  return { status, commits: () => repo.commits, requests }
}

/** The project catalog row for `DIR` with a git remote: what `useWorkspaceRemoteUrl` reads Create PR's target from. */
async function serveProjectRemote(page: Page, remote: string) {
  const row = {
    id: PROJECT_ID,
    worktree: DIR,
    name: "source-control",
    git: { remote },
    workspaces: {
      [PROJECT_ID]: { id: PROJECT_ID, workspaceId: PROJECT_ID, project_id: PROJECT_ID, kind: "local", available: true, directory: DIR },
    },
    time: { created: Date.now(), updated: Date.now() },
  }
  await page.route("**/project**", (route) => {
    if (!isApiRequest(route)) return route.continue()
    if (route.request().method() !== "GET") return route.fallback()
    const pathname = new URL(route.request().url()).pathname
    if (pathname === "/project/current") return route.fulfill(json(JSON.stringify(row)))
    if (pathname === "/project" || pathname === "/experimental/project") return route.fulfill(json(JSON.stringify([row])))
    return route.fallback()
  })
}

async function seedProject(page: Page, dir: string) {
  await page.addInitScript((dir: string) => {
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: dir,
    }
    localStorage.setItem(
      "claxedo.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: dir, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, dir)
}

function seededSessionRow() {
  return {
    id: SESSION_ID,
    slug: SESSION_ID,
    projectID: PROJECT_ID,
    directory: DIR,
    title: "source control session",
    version: "2",
    time: { created: Date.now(), updated: Date.now() },
    summary: { additions: 0, deletions: 0, files: 0 },
    config: {
      harness: { type: "opencode", model: "big-pickle", status: "ready", ready: true },
      model: { providerID: "opencode", modelID: "big-pickle" },
      provider: { id: "opencode", model: "big-pickle" },
      agent: "build",
    },
  }
}

function seededTurnRows(count: number) {
  const rows: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
  for (let i = 1; i <= count; i++) {
    const n = String(i).padStart(2, "0")
    const uid = `msg_user_${n}`
    const aid = `msg_assistant_${n}`
    const created = Date.now() - (count - i + 1) * 60_000
    rows.push({
      info: { id: uid, sessionID: SESSION_ID, role: "user", time: { created }, agent: "build", model: { providerID: "opencode", modelID: "big-pickle" } },
      parts: [{ id: `${uid}_text`, sessionID: SESSION_ID, messageID: uid, type: "text", text: `source control history message ${i}` }],
    })
    rows.push({
      info: {
        id: aid,
        sessionID: SESSION_ID,
        role: "assistant",
        time: { created: created + 500, completed: created + 1500 },
        parentID: uid,
        agent: "build",
        providerID: "opencode",
        modelID: "big-pickle",
        mode: "code",
        path: { cwd: DIR, root: DIR },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ id: `${aid}_text`, sessionID: SESSION_ID, messageID: aid, type: "text", text: `Reply ${i}. A short acknowledgement for turn ${i}.` }],
    })
  }
  return rows
}

/** The last seeded user turn's text, the one a floating session keeps on screen. */
const LAST_TURN_TEXT = `source control history message ${TURNS}`

async function installSeededWorkspace(
  page: Page,
  opts: {
    /** The project's git remote; absent by default, like the shared mock's project row. */
    remote?: string
    git?: Partial<Pick<GitFixtureSeed, "branch" | "upstream" | "ahead" | "pushRejected">>
  } = {},
) {
  const branch = opts.git?.branch ?? SEEDED_GIT.branch
  await installMockRuntime(page, {
    dir: DIR,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    workspaceId: PROJECT_ID,
    projectName: "source-control",
    currentBranch: branch,
  })
  await seedProject(page, DIR)
  const git = await installGitFixture(page, { ...SEEDED_GIT, ...opts.git, branch })
  if (opts.remote) await serveProjectRemote(page, opts.remote)

  const sessionRow = seededSessionRow()
  const listBody = JSON.stringify([sessionRow])
  const sessionBody = JSON.stringify(sessionRow)
  const messageBody = JSON.stringify({ messages: seededTurnRows(TURNS), maxEventOrdinal: 0 })

  await page.route("**/session", (route) => (route.request().method() === "GET" ? route.fulfill(json(listBody)) : route.fallback()))
  await page.route("**/session?**", (route) => (route.request().method() === "GET" ? route.fulfill(json(listBody)) : route.fallback()))
  // Bound to the session row only: a trailing `**` would also swallow `permission-mode`
  // and every other sub-resource the composer fetches on mount.
  await page.route(`**/session/${SESSION_ID}`, (route) => route.fulfill(json(sessionBody)))
  await page.route(`**/session/${SESSION_ID}?**`, (route) => route.fulfill(json(sessionBody)))
  await page.route(`**/session/${SESSION_ID}/message**`, (route) => route.fulfill(json(messageBody)))

  await page.route(sessionListRoute, (route) => {
    const url = new URL(route.request().url())
    const limit = Number(url.searchParams.get("limit") ?? "5") || 5
    return route.fulfill(json(JSON.stringify({
      view: { scope: url.searchParams.get("scope") ?? "workspace", groupBy: "none", sort: url.searchParams.get("sort") ?? "updated_desc", limit },
      items: [{
        type: "session",
        sessionRef: SESSION_ID,
        sessionId: SESSION_ID,
        title: sessionRow.title,
        directory: DIR,
        projectId: PROJECT_ID,
        createdAt: sessionRow.time.created,
        updatedAt: sessionRow.time.updated,
        tags: [],
        attachments: [],
      }],
      totalKnown: 1,
    })))
  })

  await page.route("**/file/status**", (route) => route.fulfill(json(JSON.stringify(SEEDED_STATUS))))
  await page.route("**/api/wr/diff/refs**", (route) => (isApiRequest(route) ? route.fulfill(json(JSON.stringify(SEEDED_REFS))) : route.continue()))
  await page.route("**/api/wr/diff/vcs**", (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname.replace(/^\/workspaces\/[^/]+/, "")
    const diffs = seededDiffsFor(url.searchParams)
    if (pathname === "/api/wr/diff/vcs") return route.fulfill(json(JSON.stringify(diffs)))
    if (pathname === "/api/wr/diff/vcs/file") {
      const file = url.searchParams.get("file")
      const match = diffs.find((diff) => diff.file === file)
      return match ? route.fulfill(json(JSON.stringify(match))) : route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
    }
    return route.fallback()
  })
  return { git }
}

async function gotoSession(page: Page) {
  await page.goto(`/s/${SESSION_ID}`, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="rail-sidebar"]')).toBeVisible({ timeout: 20_000 })
  await expect(sessionRoot(page)).toHaveAttribute("data-session-visible-user-count", String(TURNS), { timeout: 20_000 })
}

function sessionRoot(page: Page) {
  return page.locator(`[data-testid="session-page-root"][data-session-id="${SESSION_ID}"]`)
}

function sessionPane(page: Page) {
  return page.locator("[data-workbench-content][data-pane-id]").filter({
    has: page.locator(`[data-testid="session-content"][data-session-id="${SESSION_ID}"]`),
  })
}

function envcardShell(page: Page) {
  return page.locator(`.session-envcard-shell[data-session-id="${SESSION_ID}"]`)
}

function panelShell(page: Page) {
  return page.locator('[data-testid="workspace-panel-shell"]')
}

function panelL1Header(page: Page) {
  return panelShell(page).locator('[data-testid="workspace-panel-l1-header"]')
}

function workbenchColumn(page: Page) {
  return page.locator('[data-testid="workbench-column"]')
}

/** The panel's files column, which hosts the Files navigator or the source-control view. */
function navigatorColumn(page: Page) {
  return panelShell(page).locator('[data-testid="workspace-navigator-overlay"][data-navigator="files"]')
}

function timelineScroller(page: Page) {
  return sessionRoot(page).locator('[data-scrollable]:has([data-slot="session-turn-message-content"])').first()
}

function previousMessagesRow(page: Page) {
  return sessionRoot(page).locator('button[data-testid="timeline-previous-messages"]')
}

function transcriptPeek(page: Page) {
  return sessionRoot(page).locator('button[data-testid="session-transcript-peek"]')
}

function collapsedTranscript(page: Page) {
  return sessionRoot(page).locator('[data-session-transcript-collapsed="true"]')
}

function composerEditor(page: Page) {
  return sessionRoot(page).locator('[data-component="prompt-input"]')
}

/** Width of the single `role="main"` landmark, the column the panel covers at full view. */
async function mainWidth(page: Page) {
  const box = await page.getByRole("main").boundingBox()
  expect(box, 'role="main" has no box').not.toBeNull()
  return box!.width
}

async function panelWidth(page: Page) {
  const box = await panelShell(page).boundingBox()
  expect(box, "workspace panel shell has no box").not.toBeNull()
  return box!.width
}

function sourceControlView(page: Page) {
  return panelShell(page).locator('[data-testid="source-control-view"]')
}

function changeGroup(page: Page, id: "staged" | "changes") {
  return sourceControlView(page).locator(`[data-testid="source-control-group-${id}"]`)
}

function changeRow(page: Page, path: string) {
  return sourceControlView(page).locator(`[data-testid="source-control-row"][data-path="${path}"]`)
}

function commitRows(page: Page) {
  return sourceControlView(page).locator('[data-testid="source-control-graph"] [data-testid="source-control-commit-row"]')
}

function graphHeader(page: Page) {
  return sourceControlView(page).getByTestId("source-control-group-graph")
}

/** The Graph starts collapsed; its header opens it. */
async function expandGraph(page: Page) {
  await expect(graphHeader(page)).toHaveAttribute("data-collapsed", "true")
  await expect(commitRows(page)).toHaveCount(0)
  await graphHeader(page).getByRole("button", { expanded: false }).click()
  await expect(graphHeader(page)).not.toHaveAttribute("data-collapsed", "true")
}

function compareGroup(page: Page) {
  return sourceControlView(page).getByTestId("source-control-group-compare")
}

/** The Review tab's compare pill in the L2 toolbar slot. */
function comparePill(page: Page) {
  return page.locator('[data-testid="l2-review-toolbar-slot"] [data-testid="review-compare-trigger"]')
}

/** The picker the pill opens: portaled to the body, so located from the page. */
function compareMenu(page: Page) {
  return page.getByTestId("review-compare-menu")
}

async function openComparePicker(page: Page) {
  await expect(comparePill(page)).toBeVisible({ timeout: 15_000 })
  await comparePill(page).click()
  const menu = compareMenu(page)
  await expect(menu).toBeVisible({ timeout: 15_000 })
  await expect(menu.getByTestId("review-compare-search")).toBeFocused()
  return menu
}

function menuOptions(menu: Locator) {
  return menu.getByRole("option")
}

async function expectUncommittedReview(page: Page) {
  await expect(comparePill(page)).toHaveAttribute("data-review-mode", "uncommitted", { timeout: 15_000 })
  await expect(comparePill(page)).toContainText("Uncommitted")
  await expect(compareGroup(page)).toHaveCount(0)
}

function commitMessage(page: Page) {
  return sourceControlView(page).getByTestId("source-control-message")
}

function commitButton(page: Page) {
  return sourceControlView(page).getByTestId("source-control-commit")
}

/** Opens the panel from the header's toggle, then selects `navigator` in the panel's own
 * L2 trio: the trio has no home outside the panel column. */
async function openClassicPanelNavigator(page: Page, navigator: "Files" | "Changes" | "Processes") {
  const toggle = page.locator('[data-testid="workbench-shell-header"] [data-testid="workspace-panel-toggle"]')
  await expect(toggle).toHaveAttribute("aria-label", "Open workspace panel")
  await toggle.click()
  const panel = panelShell(page)
  await expect(panel).toHaveAttribute("data-open", "true", { timeout: 15_000 })
  await panel.getByRole("button", { name: `Open ${navigator}` }).click()
}

/** The panel's Changes navigator, selected and past its loading skeleton. Opens the panel
 * through the header toggle when it is closed. The shell is not in the DOM before the
 * first open, and `.getAttribute()` on a missing element auto-waits out the whole action
 * timeout; `.count()` answers immediately. */
async function openSourceControl(page: Page): Promise<Locator> {
  const panel = panelShell(page)
  const open = (await panel.count()) > 0 && (await panel.getAttribute("data-open")) === "true"
  if (!open) {
    await openClassicPanelNavigator(page, "Changes")
  } else if ((await panel.getAttribute("data-state-navigator")) !== "changes") {
    await panel.getByRole("button", { name: "Open Changes" }).click()
  }
  await expect(panel).toHaveAttribute("data-state-navigator", "changes", { timeout: 15_000 })
  await expect(navigatorColumn(page)).toHaveAttribute("data-open", "true", { timeout: 15_000 })
  await expect(navigatorColumn(page)).toHaveAttribute("data-navigator-kind", "changes")
  const view = sourceControlView(page)
  await expect(view).toBeVisible({ timeout: 15_000 })
  await expect(view.getByTestId("source-control-loading")).toHaveCount(0, { timeout: 15_000 })
  return view
}

/** Both group headers carry `count`, and no write is in flight. */
async function expectGroupCounts(page: Page, staged: number, changes: number) {
  await expect(changeGroup(page, "staged")).toHaveAttribute("data-count", String(staged), { timeout: 15_000 })
  await expect(changeGroup(page, "changes")).toHaveAttribute("data-count", String(changes), { timeout: 15_000 })
  await expect(sourceControlView(page)).not.toHaveAttribute("data-pending", /./)
}

async function expectRow(page: Page, path: string, group: "staged" | "changes" | "compare", status: GitStatusEntry["status"], letter: string) {
  const row = changeRow(page, path)
  await expect(row).toHaveAttribute("data-group", group, { timeout: 15_000 })
  await expect(row).toHaveAttribute("data-status", status)
  await expect(row.locator('[data-slot="open"] > span').first()).toHaveText(letter)
}

/** The row's Stage / Unstage action is hidden until the row is hovered; hover, see it appear, click it. */
async function clickRowAction(page: Page, path: string, action: "stage" | "unstage") {
  const row = changeRow(page, path)
  const button = row.locator(`[data-action="${action}"]`)
  await expect(button).toHaveCSS("opacity", "0")
  await row.hover()
  await expect(button).toHaveCSS("opacity", "1")
  await button.click()
}

async function clickChangedFile(page: Page, path: string) {
  await openSourceControl(page)
  await changeRow(page, path).locator('[data-slot="open"]').click()
}

/** The mode the Review tab is in, as its L2 toolbar names it. `exact`: "Unstaged" contains "staged". */
async function expectReviewMode(page: Page, label: "Staged" | "Unstaged") {
  await expect(page.locator('[data-testid="l2-review-toolbar-slot"]').getByText(label, { exact: true })).toBeVisible({ timeout: 15_000 })
}

/** The fixture's request ledger, as a file in the test's output directory and on the report. */
async function attachGitRequests(git: GitFixture, testInfo: TestInfo) {
  const path = testInfo.outputPath("git-requests.json")
  await writeFile(path, JSON.stringify(git.requests, null, 2))
  await testInfo.attach("git-requests", { path, contentType: "application/json" })
}

/** The panel is open and docked: a px panel narrower than the `role="main"` column,
 * the column beside it shifted over by a margin, and no floating host. */
async function expectPanelDocked(page: Page) {
  const panel = panelShell(page)
  await expect(panel).toHaveAttribute("data-state-open", "true", { timeout: 15_000 })
  await expect(panel).toHaveAttribute("data-shell-settled", "true", { timeout: 15_000 })
  await expect.poll(() => panelWidth(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(CLASSIC_PANEL_MIN_WIDTH)
  await expect.poll(async () => (await mainWidth(page)) - (await panelWidth(page)), { timeout: 15_000 }).toBeGreaterThan(WIDTH_TOLERANCE)
  await expect(workbenchColumn(page)).not.toHaveAttribute("data-floating-host", "")
  await expect(workbenchColumn(page)).toHaveCSS("margin-right", /^[1-9]\d*px$/)
}

/** The panel is open at full view: it covers the `role="main"` column and the pane
 * column is the floating host. */
async function expectPanelAtFullView(page: Page) {
  const panel = panelShell(page)
  await expect(panel).toHaveAttribute("data-state-open", "true", { timeout: 15_000 })
  await expect(panel).toHaveAttribute("data-open", "true", { timeout: 15_000 })
  await expect(panel).toHaveAttribute("data-shell-settled", "true", { timeout: 15_000 })
  await expect(workbenchColumn(page)).toHaveAttribute("data-floating-host", "", { timeout: 15_000 })
  await expect.poll(async () => Math.abs((await panelWidth(page)) - (await mainWidth(page))), { timeout: 15_000 }).toBeLessThan(WIDTH_TOLERANCE)
}

/** The click landed as a review-mode, Changes-navigator panel request. */
async function expectPanelInReviewForChanges(page: Page) {
  const panel = panelShell(page)
  await expect(panel).toHaveAttribute("data-state-mode", "review", { timeout: 15_000 })
  await expect(panel).toHaveAttribute("data-state-navigator", "changes")
  await expect(panel).toHaveAttribute("data-state-workspace-dir", DIR)
}

/** The Review tab is the selected workspace tab and `path` is the focused diff in it. */
async function expectReviewFocused(page: Page, path: string) {
  const panel = panelShell(page)
  await expect(panel.locator('[data-slot="workspace-tab"][data-workspace-tab-id="review"]')).toHaveAttribute("data-selected", "true", { timeout: 15_000 })
  await expect(panel.locator('[data-testid="review-pane-root"]')).toBeVisible({ timeout: 15_000 })
  const file = panel.locator(`[data-component="session-review"] [data-review-file="${path}"]`)
  await expect(file).toBeVisible({ timeout: 15_000 })
  await expect(file, `${path} is listed but not the focused (selected) diff`).toHaveAttribute("data-selected", "", { timeout: 15_000 })
}

async function expectSessionFloating(page: Page) {
  await expect(sessionPane(page)).toHaveAttribute("data-pane-presentation", "floating", { timeout: 15_000 })
  await expect(envcardShell(page)).toHaveAttribute("data-session-presentation", "floating", { timeout: 15_000 })
}

async function expectSessionDocked(page: Page) {
  await expect(sessionPane(page)).toHaveAttribute("data-pane-presentation", "docked", { timeout: 15_000 })
  await expect(envcardShell(page)).toHaveAttribute("data-session-presentation", "docked", { timeout: 15_000 })
}

function lastTurnContent(page: Page) {
  return sessionRoot(page).locator('[data-slot="session-turn-message-content"]', { hasText: LAST_TURN_TEXT })
}

async function expectScrolledToEnd(page: Page) {
  const scroller = timelineScroller(page)
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), { timeout: 15_000 })
    .toBeLessThan(20)
}

/** The video is written on context close, so its path is the one durable pointer this
 * spec can leave for a reviewer; attached to the report beside the evidence PNGs. */
async function attachVideoPath(page: Page, testInfo: TestInfo) {
  const path = await page.video()?.path()
  if (path) await testInfo.attach("video-path", { body: path, contentType: "text/plain" })
}

test.describe("core source control @core", () => {
  // Each scenario is a cold `/s/:id` navigation plus panel motion.
  test.beforeEach(() => {
    test.slow()
  })

  test("the Changes navigator shows the commit box, both groups with status letters, the graph, and Publish Branch without Create PR off a non-GitHub remote", async ({ page }, testInfo) => {
    const { git } = await installSeededWorkspace(page, { remote: GITLAB_REMOTE })
    await gotoSession(page)
    await expectRailRowVisible({ page, sessionId: SESSION_ID })
    await expectSessionDocked(page)
    await expect(panelShell(page)).toHaveCount(0)

    const view = await openSourceControl(page)
    await expectPanelDocked(page)
    await expectSessionDocked(page)

    await expect(commitMessage(page)).toBeVisible()
    await expect(commitMessage(page)).toHaveValue("")
    await expect(commitButton(page)).toBeDisabled()
    await expect(view.getByTestId("source-control-commit-menu")).toBeVisible()

    await expectGroupCounts(page, 1, 3)
    await expectRow(page, STAGED_FILE, "staged", "modified", "M")
    await expectRow(page, UNSTAGED_FILE, "changes", "modified", "M")
    await expectRow(page, DELETED_FILE, "changes", "deleted", "D")
    await expectRow(page, UNTRACKED_FILE, "changes", "untracked", "U")

    await expandGraph(page)
    const rows = commitRows(page)
    await expect(rows).toHaveCount(SEEDED_GIT.commits.length, { timeout: 15_000 })
    for (const [index, commit] of SEEDED_GIT.commits.entries()) {
      await expect(rows.nth(index)).toHaveAttribute("data-hash", commit.hash)
      await expect(rows.nth(index)).toContainText(commit.subject)
    }

    // No upstream: Publish Branch, not Push; a GitLab remote: no compare link.
    await expect(view.getByTestId("source-control-publish")).toBeVisible()
    await expect(view.getByTestId("source-control-push")).toHaveCount(0)
    await expect(view.getByTestId("source-control-up-to-date")).toHaveCount(0)
    await expect(view.getByTestId("source-control-create-pr")).toHaveCount(0)
    await captureEvidence({ page, spec: SPEC, scenario: "source-control-seeded" })

    // Both reads went to the fixture.
    expect(git.requests.map((request) => `${request.method} ${request.route}`)).toEqual(expect.arrayContaining(["GET status", "GET log"]))
    await attachGitRequests(git, testInfo)
  })

  test("every git request names the worktree it is scoped to", async ({ page }, testInfo) => {
    // The workspace-runtime client's `git` namespace takes no directory, so the
    // scope rides on the URL: `sdk.tsx` stamps `?directory=` onto every runtime
    // request through `scopeRuntimeRequestUrl`, and the real server resolves the
    // workspace from that query (`runtime-dispatch/internals.ts` requestWorkspace).
    // The fixture answers unscoped requests too, which is why the scope is its
    // own scenario: nothing else here fails if the client stops stamping it.
    const { git } = await installSeededWorkspace(page)
    await gotoSession(page)
    await openSourceControl(page)
    await expectGroupCounts(page, 1, 3)
    await clickRowAction(page, UNSTAGED_FILE, "stage")
    await expectGroupCounts(page, 2, 2)
    await attachGitRequests(git, testInfo)
    expect(git.requests.map((request) => request.route)).toEqual(expect.arrayContaining(["status", "log", "stage"]))
    for (const request of git.requests) {
      expect(request.directory, `${request.method} ${request.url} names no worktree`).toBe(DIR)
    }
  })

  test("hovering a Changes row stages it, Unstage returns it, and Stage all empties the Changes group", async ({ page }) => {
    const { git } = await installSeededWorkspace(page)
    await gotoSession(page)
    const view = await openSourceControl(page)
    await expectGroupCounts(page, 1, 3)

    await clickRowAction(page, UNSTAGED_FILE, "stage")
    await expectGroupCounts(page, 2, 2)
    await expectRow(page, UNSTAGED_FILE, "staged", "modified", "M")
    expect(git.requests.filter((request) => request.route === "stage").map((request) => request.body)).toEqual([{ paths: [UNSTAGED_FILE] }])

    await clickRowAction(page, UNSTAGED_FILE, "unstage")
    await expectGroupCounts(page, 1, 3)
    await expectRow(page, UNSTAGED_FILE, "changes", "modified", "M")
    expect(git.requests.filter((request) => request.route === "unstage").map((request) => request.body)).toEqual([{ paths: [UNSTAGED_FILE] }])

    // Stage all lives in the Changes header and is hidden until the header is hovered.
    // The pointer still rests where the unstaged row's action was, which the shrunken
    // Staged group has just slid the Changes header under; park it on the message box.
    await commitMessage(page).hover()
    const header = changeGroup(page, "changes")
    const stageAll = header.locator('[data-action="stage-all"]')
    await expect(stageAll).toHaveCSS("opacity", "0")
    await header.hover()
    await expect(stageAll).toHaveCSS("opacity", "1")
    await stageAll.click()
    await expectGroupCounts(page, 4, 0)
    await expect(view.locator('[data-testid="source-control-row"][data-group="changes"]')).toHaveCount(0)
    // Staging an untracked file adds it: the letter follows the index, as git's does.
    await expectRow(page, UNTRACKED_FILE, "staged", "added", "A")
    await expectRow(page, DELETED_FILE, "staged", "deleted", "D")
    expect(git.status().staged.map((entry) => entry.path).sort()).toEqual([DELETED_FILE, UNTRACKED_FILE, STAGED_FILE, UNSTAGED_FILE].sort())
    await captureEvidence({ page, spec: SPEC, scenario: "source-control-staged-all" })
  })

  test("Commit needs a message; committing empties Staged, tops the Graph with the subject, and clears the box", async ({ page }) => {
    const { git } = await installSeededWorkspace(page)
    await gotoSession(page)
    await openSourceControl(page)
    await expectGroupCounts(page, 1, 3)
    await expect(commitButton(page)).toBeDisabled()

    const subject = "feat: commit from the Changes navigator"
    await commitMessage(page).fill(`${subject}\n\nA body line the graph never shows.`)
    await expect(commitButton(page)).toBeEnabled()
    await commitButton(page).click()

    await expectGroupCounts(page, 0, 3)
    await expandGraph(page)
    const rows = commitRows(page)
    await expect(rows).toHaveCount(SEEDED_GIT.commits.length + 1, { timeout: 15_000 })
    await expect(rows.first()).toHaveAttribute("data-hash", git.commits()[0].hash)
    await expect(rows.first()).toContainText(subject)
    await expect(rows.nth(1)).toHaveAttribute("data-hash", SEEDED_GIT.commits[0].hash)
    await expect(commitMessage(page)).toHaveValue("")
    await expect(commitButton(page)).toBeDisabled()
    expect(git.requests.filter((request) => request.route === "commit-staged").map((request) => request.body)).toEqual([
      { message: `${subject}\n\nA body line the graph never shows.`, amend: false },
    ])
    expect(git.status().staged).toEqual([])
    await captureEvidence({ page, spec: SPEC, scenario: "source-control-committed" })
  })

  test("⌘⏎ in the message box commits", async ({ page }) => {
    const { git } = await installSeededWorkspace(page)
    await gotoSession(page)
    await openSourceControl(page)
    await expectGroupCounts(page, 1, 3)

    const subject = "feat: commit from the keyboard"
    await commitMessage(page).fill(subject)
    await commitMessage(page).press("ControlOrMeta+Enter")

    await expectGroupCounts(page, 0, 3)
    await expandGraph(page)
    await expect(commitRows(page).first()).toContainText(subject, { timeout: 15_000 })
    await expect(commitMessage(page)).toHaveValue("")
    expect(git.commits()[0]?.subject).toBe(subject)
  })

  test("a staged row opens the Review tab in Staged mode and an unstaged row in Unstaged mode", async ({ page }) => {
    await installSeededWorkspace(page)
    await gotoSession(page)

    await clickChangedFile(page, STAGED_FILE)
    await expectPanelInReviewForChanges(page)
    await expectReviewFocused(page, STAGED_FILE)
    await expectReviewMode(page, "Staged")
    await expect(changeRow(page, STAGED_FILE)).toHaveClass(/bg-surface-base-active/)
    await captureEvidence({ page, spec: SPEC, scenario: "source-control-review-staged" })

    await changeRow(page, UNSTAGED_FILE).locator('[data-slot="open"]').click()
    await expectReviewFocused(page, UNSTAGED_FILE)
    await expectReviewMode(page, "Unstaged")
    await expect(changeRow(page, UNSTAGED_FILE)).toHaveClass(/bg-surface-base-active/)
    await expect(changeRow(page, STAGED_FILE)).not.toHaveClass(/bg-surface-base-active/)
    await captureEvidence({ page, spec: SPEC, scenario: "source-control-review-unstaged" })
  })

  test("the compare picker filters branches, tags and commits by substring and closes on Escape", async ({ page }) => {
    await installSeededWorkspace(page)
    await gotoSession(page)
    await openSourceControl(page)
    await expectUncommittedReview(page)

    const menu = await openComparePicker(page)
    await expect(menuOptions(menu)).toHaveText([
      "Uncommitted changes",
      DEFAULT_BRANCH,
      COMPARE_BRANCH,
      `origin/${DEFAULT_BRANCH}`,
      "v1.0.0",
      ...SEEDED_GIT.commits.map((commit) => `${commit.shortHash}${commit.subject}`),
    ])

    await page.keyboard.type("compare")
    await expect(menuOptions(menu)).toHaveText(["Uncommitted changes", COMPARE_BRANCH])
    await captureEvidence({ page, spec: SPEC, scenario: "compare-search-branch" })

    await menu.getByTestId("review-compare-search").fill("seeded")
    await expect(menuOptions(menu)).toHaveText(["Uncommitted changes", ...SEEDED_GIT.commits.map((commit) => `${commit.shortHash}${commit.subject}`)])

    await menu.getByTestId("review-compare-search").fill("nothing here")
    await expect(menuOptions(menu)).toHaveText(["Uncommitted changes"])
    await expect(menu.getByTestId("review-compare-no-matches")).toHaveText("No matching refs")

    await page.keyboard.press("Escape")
    await expect(compareMenu(page)).toHaveCount(0, { timeout: 15_000 })
    await expect(comparePill(page)).toHaveAttribute("aria-expanded", "false")
    await expectUncommittedReview(page)
  })

  test("picking a branch shows the Compared changes group with the branch's files, and Uncommitted changes removes it", async ({ page }) => {
    await installSeededWorkspace(page)
    await gotoSession(page)
    await openSourceControl(page)
    await expectGroupCounts(page, 1, 3)

    const menu = await openComparePicker(page)
    await menu.getByTestId("review-compare-search").fill("compare")
    await menuOptions(menu).filter({ hasText: COMPARE_BRANCH }).click()
    await expect(compareMenu(page)).toHaveCount(0, { timeout: 15_000 })

    await expect(comparePill(page)).toHaveAttribute("data-review-mode", "to-from", { timeout: 15_000 })
    await expect(comparePill(page)).toContainText(COMPARE_BRANCH)
    await expect(comparePill(page)).toContainText(DEFAULT_BRANCH)

    const group = compareGroup(page)
    await expect(group).toBeVisible({ timeout: 15_000 })
    await expect(group).toHaveAttribute("data-count", "2", { timeout: 15_000 })
    await expect(group).toHaveAttribute("data-active", "true")
    await expect(group).toContainText(`${COMPARE_BRANCH} → ${DEFAULT_BRANCH}`)
    await expect(sourceControlView(page).getByTestId("source-control-groups").locator("> section").first()).toHaveAttribute("data-testid", "source-control-section-compare")
    await expectRow(page, COMPARE_FILE, "compare", "added", "A")
    await expectRow(page, COMPARE_DOC, "compare", "added", "A")
    await expect(changeRow(page, COMPARE_FILE).getByText("+2")).toBeVisible()
    await expectGroupCounts(page, 1, 3)
    await captureEvidence({ page, spec: SPEC, scenario: "compare-branch-group" })

    await changeRow(page, COMPARE_FILE).locator('[data-slot="open"]').click()
    await expectPanelInReviewForChanges(page)
    await expectReviewFocused(page, COMPARE_FILE)
    await expect(comparePill(page)).toHaveAttribute("data-review-mode", "to-from")
    await expect(changeRow(page, COMPARE_FILE)).toHaveClass(/bg-surface-base-active/)
    await captureEvidence({ page, spec: SPEC, scenario: "compare-branch-file-focused" })

    const reopened = await openComparePicker(page)
    await reopened.getByTestId("review-compare-uncommitted").click()
    await expectUncommittedReview(page)
    await expectGroupCounts(page, 1, 3)
  })

  test("clicking a graph commit shows its files and the pill; clicking it again returns to Uncommitted", async ({ page }) => {
    await installSeededWorkspace(page)
    await gotoSession(page)
    await openSourceControl(page)
    await expectUncommittedReview(page)
    await expandGraph(page)

    const [second, first] = SEEDED_GIT.commits
    const secondRow = commitRows(page).filter({ has: page.locator(`[data-hash="${second.hash}"]`) }).or(commitRows(page).nth(0))
    await expect(secondRow).toHaveAttribute("aria-selected", "false")
    await secondRow.click()

    await expect(secondRow).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
    await expect(secondRow).toHaveClass(/bg-surface-base-active/)
    await expect(commitRows(page).nth(1)).toHaveAttribute("aria-selected", "false")
    await expect(comparePill(page)).toHaveAttribute("data-review-mode", "to-from", { timeout: 15_000 })
    await expect(comparePill(page)).toContainText(first.shortHash)
    await expect(comparePill(page)).toContainText(second.shortHash)

    const group = compareGroup(page)
    await expect(group).toHaveAttribute("data-count", "1", { timeout: 15_000 })
    await expect(group).toContainText(`${first.shortHash} → ${second.shortHash}`)
    await expectRow(page, SECOND_COMMIT_FILE, "compare", "added", "A")
    await expect(changeRow(page, FIRST_COMMIT_FILE)).toHaveCount(0)
    await expect(panelShell(page).locator(`[data-component="session-review"] [data-review-file="${SECOND_COMMIT_FILE}"]`)).toBeVisible({ timeout: 15_000 })
    await captureEvidence({ page, spec: SPEC, scenario: "compare-graph-commit" })

    // The root commit compares against the empty tree.
    await commitRows(page).nth(1).click()
    await expect(commitRows(page).nth(1)).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
    await expect(secondRow).toHaveAttribute("aria-selected", "false")
    await expect(group).toHaveAttribute("data-count", "1", { timeout: 15_000 })
    await expect(group).toContainText(`${EMPTY_TREE.slice(0, 7)} → ${first.shortHash}`)
    await expectRow(page, FIRST_COMMIT_FILE, "compare", "added", "A")
    await expect(changeRow(page, SECOND_COMMIT_FILE)).toHaveCount(0)

    await commitRows(page).nth(1).click()
    await expect(commitRows(page).nth(1)).toHaveAttribute("aria-selected", "false", { timeout: 15_000 })
    await expectUncommittedReview(page)
    await expect(panelShell(page).locator(`[data-component="session-review"] [data-review-file="${FOCUS_FILE}"]`)).toBeVisible({ timeout: 15_000 })
    await captureEvidence({ page, spec: SPEC, scenario: "compare-graph-deselected" })
  })

  test("Create PR links to the GitHub compare page for a branch off the default", async ({ page }) => {
    await installSeededWorkspace(page, { remote: GITHUB_REMOTE, git: { branch: FEATURE_BRANCH } })
    await gotoSession(page)
    const view = await openSourceControl(page)

    const link = view.getByTestId("source-control-create-pr")
    await expect(link).toBeVisible({ timeout: 15_000 })
    await expect(link).toHaveAttribute(
      "href",
      `https://github.com/acme/app/compare/${DEFAULT_BRANCH}...${encodeURIComponent(FEATURE_BRANCH)}?expand=1`,
    )
    await expect(link).toHaveAttribute("target", "_blank")
    await expect(link).toHaveAttribute("rel", "noopener noreferrer")
    await captureEvidence({ page, spec: SPEC, scenario: "source-control-create-pr" })
  })

  test("a rejected push reports git's message under the commit box", async ({ page }) => {
    const { git } = await installSeededWorkspace(page, { git: { pushRejected: PUSH_REJECTION } })
    await gotoSession(page)
    const view = await openSourceControl(page)

    await view.getByTestId("source-control-publish").click()
    const error = view.getByTestId("source-control-error")
    await expect(error).toBeVisible({ timeout: 15_000 })
    await expect(error).toHaveText(`Push rejected: ${PUSH_REJECTION}`)
    await expect(commitMessage(page)).toHaveAttribute("aria-invalid", "true")
    // Still unpublished: the button stays, and the fixture saw one upstream-setting push.
    await expect(view.getByTestId("source-control-publish")).toBeVisible()
    expect(git.requests.filter((request) => request.route === "push").map((request) => request.body)).toEqual([{ setUpstream: true }])
    await captureEvidence({ page, spec: SPEC, scenario: "source-control-push-rejected" })
  })

  test("Maximize opens the panel at full view over a floating session whose history collapses to the last turn until revealed; Restore docks it again", async ({ page }, testInfo) => {
    await installSeededWorkspace(page)
    await gotoSession(page)
    await expectSessionDocked(page)

    await clickChangedFile(page, FOCUS_FILE)
    await expectPanelDocked(page)
    await expectReviewFocused(page, FOCUS_FILE)

    const l1 = panelL1Header(page)
    await l1.getByRole("button", { name: "Maximize workspace panel" }).click()
    await expectPanelAtFullView(page)
    await expectPanelInReviewForChanges(page)
    await expectSessionFloating(page)
    await expect(navigatorColumn(page)).toHaveAttribute("data-open", "true")
    await expect(sourceControlView(page)).toBeVisible()
    await captureEvidence({ page, spec: SPEC, scenario: "full-view-open" })

    // The floating composer is the same PromptInput node, reachable over the panel.
    const editor = composerEditor(page)
    await expect(editor).toBeVisible()
    await editor.click()
    await expect(editor).toBeFocused()
    await page.keyboard.type("x")
    await expect(editor).toContainText("x")
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.press("Backspace")
    await expect(editor).not.toContainText("x")

    // Floating collapses the whole transcript behind the peek strip, whose count is every
    // visible turn, while the history window itself holds only the last turn.
    const root = sessionRoot(page)
    await expect(root).toHaveAttribute("data-session-rendered-user-count", "1", { timeout: 15_000 })
    await expect(root).toHaveAttribute("data-session-visible-user-count", String(TURNS))
    const peek = transcriptPeek(page)
    await expect(peek).toBeVisible({ timeout: 15_000 })
    await expect(peek).toHaveAttribute("data-count", String(TURNS))
    await expect(peek).toHaveAttribute("aria-expanded", "false")
    await expect(collapsedTranscript(page)).toHaveCount(1)
    await expect(previousMessagesRow(page)).toHaveCount(0)

    // Peeking shows the last turn and the row that counts the history above it.
    await peek.click()
    await expect(peek).toHaveAttribute("aria-expanded", "true")
    await expect(collapsedTranscript(page)).toHaveCount(0)
    await expect(lastTurnContent(page)).toBeVisible({ timeout: 15_000 })
    await expect(root).toHaveAttribute("data-session-rendered-user-count", "1")
    const row = previousMessagesRow(page)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).toHaveAttribute("data-count", String(TURNS - 1))
    await captureEvidence({ page, spec: SPEC, scenario: "transcript-peeked" })

    await row.click()
    await expect(row).toHaveCount(0, { timeout: 15_000 })
    await expect(root).toHaveAttribute("data-session-rendered-user-count", String(TURNS), { timeout: 15_000 })
    await expect(lastTurnContent(page)).toBeVisible()
    await expectScrolledToEnd(page)
    await captureEvidence({ page, spec: SPEC, scenario: "previous-messages-revealed" })

    // Restore docks the session beside a px-width panel again: the peek strip is gone
    // and the window reopens at its full initial size, every seeded turn, no row above it.
    await l1.getByRole("button", { name: "Restore workspace panel width" }).click()
    await expect(l1.getByRole("button", { name: "Maximize workspace panel" })).toBeVisible({ timeout: 15_000 })
    await expect(workbenchColumn(page)).not.toHaveAttribute("data-floating-host", "", { timeout: 15_000 })
    await expectPanelDocked(page)
    await expectSessionDocked(page)
    await expect(transcriptPeek(page)).toHaveCount(0, { timeout: 15_000 })
    await expect(collapsedTranscript(page)).toHaveCount(0)
    await expect(root).toHaveAttribute("data-session-rendered-user-count", String(TURNS), { timeout: 15_000 })
    await expect(previousMessagesRow(page)).toHaveCount(0)
    await expect(lastTurnContent(page)).toBeVisible({ timeout: 15_000 })
    await expect(sourceControlView(page)).toBeVisible()
    await captureEvidence({ page, spec: SPEC, scenario: "restored-docked" })
    await attachVideoPath(page, testInfo)
  })
})
