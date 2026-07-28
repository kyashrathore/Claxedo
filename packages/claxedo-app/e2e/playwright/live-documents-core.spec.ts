/**
 * SPEC: Documents core against the real local backend (Tier L)
 *
 * This file complements `documents-core.spec.ts`: it installs no request routes and
 * starts a real isolated claxedo-server with a scratch CLAXEDO_DATA_DIR. The browser
 * creates and edits through the production Documents UI and the production HTTP,
 * SQLite, filesystem, CAS, and snapshot implementations. Restart uses
 * the same scratch data directory and a new server process.
 *
 * An open editor does NOT live-refresh on an external/agent write — the external-change
 * controller and the `/documents/events` SSE were removed. A
 * competing durable write is caught as a CAS conflict on the next save, never a silent
 * loss. The integrated grant journey uses the real `/docs` picker to grant a real Session
 * path, then drives an ordinary bash process against that path before checking the durable
 * write-back, the CAS conflict on save, the parked session draft, and visible version
 * restore. The companion server smoke executes the same write through `sessionEnvBashTool`,
 * keeping provider health separate from the deterministic Documents release gate.
 */
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const LIVE = process.env.CLAXEDO_E2E_LIVE === "1"
const APP_DIR = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")
const BACKEND_PORT = Number(process.env.CLAXEDO_E2E_LIVE_BACKEND_PORT ?? 3001)
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

type DocumentSummary = {
  id: string
  project_id: string
  display_name: string
  managed_relative_path: string | null
}

let server: ChildProcess | undefined
let serverLog = ""
let dataDir = ""
let scratchHome = ""
let workspace = ""
let workspaceId = ""
let createdDocument: DocumentSummary | undefined

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function indexUrl() {
  return `/w/${encodeURIComponent(workspace)}/page/__index__`
}

function documentUrl(id: string) {
  return `/w/${encodeURIComponent(workspace)}/page/${encodeURIComponent(id)}`
}

async function assertBackendPortFree() {
  const found = await execFileAsync("lsof", ["-i", `:${BACKEND_PORT}`, "-sTCP:LISTEN", "-t"]).catch(() => undefined)
  const pids =
    found?.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean) ?? []
  if (!pids.length) return
  throw new Error(
    `GATING: port ${BACKEND_PORT} is already owned by PID(s) ${pids.join(", ")}. ` +
      "The shared Vite server bakes in this backend port, so using it would mutate an ambient server rather than " +
      "the isolated scratch Documents backend. Stop that process, or restart Vite and this spec with matching " +
      "VITE_CLAXEDO_SERVER_URL and CLAXEDO_E2E_LIVE_BACKEND_PORT values.",
  )
}

async function waitForHealth(timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ready = await fetch(`${BACKEND_URL}/api/claxedo/health`)
      .then((response) => response.ok)
      .catch(() => false)
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(
    `GATING: isolated claxedo-server did not become healthy within ${timeoutMs}ms. Server log tail:\n` +
      serverLog.split("\n").slice(-60).join("\n"),
  )
}

async function startServer() {
  serverLog = ""
  server = spawn("bun", ["run", "start"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      CLAXEDO_DATA_DIR: dataDir,
      CLAXEDO_SERVER_PORT: String(BACKEND_PORT),
      CLAXEDO_SERVER_URL: BACKEND_URL,
      CLAXEDO_WORKGRAPH_REPOSITORY: REPO_ROOT,
      HOME: scratchHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout?.on("data", (chunk) => (serverLog += chunk.toString()))
  server.stderr?.on("data", (chunk) => (serverLog += chunk.toString()))
  await waitForHealth()
}

async function stopServer() {
  const current = server
  if (!current || current.exitCode !== null) {
    server = undefined
    return
  }
  current.kill("SIGTERM")
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (current.exitCode === null) current.kill("SIGKILL")
      resolve()
    }, 5_000)
    current.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
  })
  server = undefined
}

async function makeWorkspace() {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-live-documents-workspace-")))
  await initializeWorkspaceCheckout()
  await registerWorkspace()
}

async function initializeWorkspaceCheckout() {
  await execFileAsync("git", ["init"], { cwd: workspace })
  await fs.writeFile(path.join(workspace, "README.md"), "live Documents core workspace\n")
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "add", "-A"], {
    cwd: workspace,
  })
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init"], {
    cwd: workspace,
  })
}

async function registerWorkspace() {
  const response = await fetch(
    `${BACKEND_URL}/api/workspace/resolve?directory=${encodeURIComponent(workspace)}&create=true`,
  )
  expect(response.ok, await response.clone().text()).toBe(true)
  workspaceId = ((await response.json()) as { workspaceId: string }).workspaceId
}

async function seedProject(page: Page) {
  await page.addInitScript(
    ({ dir, backendUrl }) => {
      localStorage.clear()
      ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
        serverUrl: backendUrl,
        activeDirectory: dir,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: { local: [{ worktree: dir, workspaceId: dir, expanded: true }] },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
    },
    { dir: workspace, backendUrl: BACKEND_URL },
  )
}

async function requestJson<T>(pathname: string, init?: RequestInit) {
  const response = await fetch(`${BACKEND_URL}${pathname}`, init)
  if (!response.ok)
    throw new Error(`${init?.method ?? "GET"} ${pathname} failed (${response.status}): ${await response.text()}`)
  return (await response.json()) as T
}

async function listDocuments() {
  return await requestJson<DocumentSummary[]>(`/documents?directory=${encodeURIComponent(workspace)}`)
}

async function createSession() {
  return await requestJson<{ id: string }>(`/session?directory=${encodeURIComponent(workspace)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": workspace },
    body: JSON.stringify({ title: "Documents integrated live agent" }),
  })
}

async function runGrantedPathBash(file: string, markdown: string) {
  const result = await execFileAsync("sh", ["-c", 'printf %s "$1" > "$2"', "documents-e2e", markdown, file])
  expect(result.stderr).toBe("")
}

async function sourceEditor(page: Page) {
  const source = page.getByLabel("Document Markdown source")
  await expect(source).toBeVisible({ timeout: 30_000 })
  return source
}

async function saveSource(page: Page, markdown: string) {
  const source = await sourceEditor(page)
  await source.fill(markdown)
  await expect(page.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible()
  return source
}

function evidenceName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

async function proveGeometry(page: Page, locator: Locator, testInfo: TestInfo, name: string) {
  await expect(locator).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  const bounds = await locator.boundingBox()
  expect(bounds, `${name} must have a rendered box`).not.toBeNull()
  expect(bounds!.width, `${name} width`).toBeGreaterThan(0)
  expect(bounds!.height, `${name} height`).toBeGreaterThan(0)
  const viewport = page.viewportSize()
  expect(viewport, `${name} requires a viewport`).not.toBeNull()
  expect(bounds!.x + bounds!.width).toBeGreaterThan(0)
  expect(bounds!.y + bounds!.height).toBeGreaterThan(0)
  expect(bounds!.x).toBeLessThan(viewport!.width)
  expect(bounds!.y).toBeLessThan(viewport!.height)
  expect(
    await locator.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const x = Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2))
      const y = Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2))
      const hit = document.elementFromPoint(x, y)
      return hit === element || element.contains(hit)
    }),
    `${name} center must survive document.elementFromPoint`,
  ).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`evidence-${evidenceName(name)}.png`) })
}

test.describe.serial("live Documents core backend @live", () => {
  test.skip(
    !LIVE,
    "Tier L: set CLAXEDO_E2E_LIVE=1 to run live-documents-core against an isolated real claxedo-server, " +
      "SQLite index, managed filesystem, CAS, and snapshot history.",
  )

  test.beforeAll(async () => {
    if (!LIVE) return
    await assertBackendPortFree()
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-live-documents-data-"))
    scratchHome = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-live-documents-home-"))
    await startServer()
    await makeWorkspace()
  })

  test.afterAll(async () => {
    if (!LIVE) return
    await stopServer()
    await Promise.all(
      [dataDir, scratchHome, workspace]
        .filter(Boolean)
        .map((directory) => fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)),
    )
  })

  test.beforeEach(async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
    testInfo.annotations.push({
      type: "evidence-tier",
      description: "Tier L real browser + real Documents HTTP/filesystem backend; zero route interception",
    })
  })

  test("real rich typing autosaves exact filesystem bytes and reopens @documents-rich-live-canary", async ({
    page,
  }) => {
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    let created: DocumentSummary | undefined
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text())
    })
    page.on("response", async (response) => {
      const request = response.request()
      const url = new URL(response.url())
      if (request.method() !== "POST" || url.pathname !== "/documents" || !response.ok()) return
      expect(url.origin).toBe(BACKEND_URL)
      created = (await response.json()) as DocumentSummary
    })
    await seedProject(page)
    await page.goto(indexUrl())
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible({ timeout: 30_000 })
    await page.getByRole("button", { name: "New document" }).click()
    // "New document" is a searchable project picker, not a direct-create button
    // (document-index.tsx's `NewDocumentButton`/`createInProject`): pick the sole
    // fixture project from its list before a document actually gets created —
    // the same flow the mocked Tier M sibling (documents-core.spec.ts) drives.
    await page.locator('.documents-new-list-host [data-slot="list-item"]').first().click()

    const title = page.getByRole("textbox", { name: "Document name" })
    const rich = page.getByRole("textbox", { name: "Document rich editor" })
    const richHandle = await rich.elementHandle()
    if (!richHandle) throw new Error("Live rich editor did not mount")
    await title.fill("Live rich canary")
    await rich.click()
    await page.keyboard.type("Live rich typing")
    await page.keyboard.press("Enter")
    await page.keyboard.type("Second paragraph")
    // Scoped like the helpers above: a toast also carries role=status, so the
    // bare role query is ambiguous the moment any toast is on screen.
    await expect(page.getByRole("status").filter({ hasText: /Unsaved changes|Saving/ })).toBeVisible()
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 20_000 })
    expect(await rich.evaluate((element) => document.activeElement === element)).toBe(true)
    const richHandleAfterSave = await rich.elementHandle()
    if (!richHandleAfterSave) throw new Error("Live rich editor disappeared after autosave")
    expect(await page.evaluate(([before, after]) => before === after, [richHandle, richHandleAfterSave])).toBe(true)

    await expect.poll(() => created).toBeTruthy()
    expect(created?.managed_relative_path).toBeTruthy()
    expect((await requestJson<DocumentSummary>(`/documents/${encodeURIComponent(created!.id)}`)).display_name).toBe(
      "Live rich canary",
    )
    const content = await requestJson<{ markdown: string }>(`/documents/${encodeURIComponent(created!.id)}/content`)
    expect(content.markdown).toBe("Live rich typing\n\nSecond paragraph")
    expect(await fs.readFile(path.join(dataDir, "documents", created!.managed_relative_path!), "utf8")).toBe(
      content.markdown,
    )

    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    await page.goto(documentUrl(created!.id))
    await expect(page.getByRole("textbox", { name: "Document rich editor" })).toContainText("Second paragraph")
    await expect(page.getByText("Source mode")).toHaveCount(0)
    expect(pageErrors).toEqual([])
    // Chromium reports aborted SSE reads as `network error` during a full
    // document navigation. Editing/autosave was asserted clean immediately
    // above; only these exact navigation-teardown diagnostics are allowed.
    expect(
      consoleErrors.filter(
        (message) =>
          message !== "TypeError: network error" &&
          message !== "[documents] editor persistence error TypeError: network error",
      ),
    ).toEqual([])
  })

  test("real create/edit survives a full server restart with exact bytes", async ({ page }, testInfo) => {
    const documentRequests: string[] = []
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/documents")) documentRequests.push(request.url())
    })
    await seedProject(page)
    await page.goto(indexUrl())
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible({ timeout: 30_000 })
    const createdResponse = page.waitForResponse((response) => {
      const request = response.request()
      return request.method() === "POST" && new URL(response.url()).pathname === "/documents" && response.ok()
    })
    await page.getByRole("button", { name: "New document" }).click()
    // Same project picker as the canary above: pick the sole fixture project first.
    await page.locator('.documents-new-list-host [data-slot="list-item"]').first().click()
    await expect(page.getByRole("main", { name: "Document editor" })).toBeVisible({ timeout: 30_000 })
    createdDocument = (await (await createdResponse).json()) as DocumentSummary

    const exact = "Heading\n=======\n\nreal managed bytes survive restart\n"
    const current = await requestJson<{ version: string }>(`/documents/${createdDocument.id}/content`)
    await requestJson(`/documents/${createdDocument.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": current.version },
      body: JSON.stringify({ markdown: exact }),
    })
    await page.reload({ waitUntil: "domcontentloaded" })
    const source = await sourceEditor(page)
    await expect(source).toHaveValue(exact)
    expect(createdDocument?.managed_relative_path).toBeTruthy()
    const content = await requestJson<{ markdown: string }>(
      `/documents/${encodeURIComponent(createdDocument!.id)}/content`,
    )
    expect(content.markdown).toBe(exact)
    expect(await fs.readFile(path.join(dataDir, "documents", createdDocument!.managed_relative_path!), "utf8")).toBe(
      exact,
    )
    expect(documentRequests.length).toBeGreaterThan(0)
    expect(documentRequests.every((url) => new URL(url).origin === BACKEND_URL)).toBe(true)
    await proveGeometry(page, source, testInfo, "real-managed-document-saved")

    await stopServer()
    await fs.rm(workspace, { recursive: true, force: true })
    await fs.mkdir(workspace, { recursive: true })
    await initializeWorkspaceCheckout()
    await startServer()
    await registerWorkspace()
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByRole("main", { name: "Document editor" })).toBeVisible({ timeout: 30_000 })
    const reopened = await sourceEditor(page)
    await expect(reopened).toHaveValue(exact)
    expect((await listDocuments()).map((entry) => entry.id)).toContain(createdDocument!.id)
    await proveGeometry(page, reopened, testInfo, "real-managed-document-reopened-after-server-restart")
  })

  // Live-refresh of an open editor was intentionally removed: no `/documents/events`
  // SSE, no external-change controller. A competing durable write is caught as a
  // CAS conflict on the human's next save, preserving both sides.
  test("a competing durable write is caught as a CAS conflict on save, and a version restores", async ({
    page,
  }, testInfo) => {
    expect(createdDocument).toBeTruthy()
    await seedProject(page)
    await page.goto(documentUrl(createdDocument!.id))
    await expect(page.getByRole("main", { name: "Document editor" })).toBeVisible({ timeout: 30_000 })
    let source = await sourceEditor(page)

    const baseline = "Heading\n=======\n\nreal managed bytes survive restart\n"
    await expect(source).toHaveValue(baseline)
    const canonical = path.join(dataDir, "documents", createdDocument!.managed_relative_path!)

    // A competing durable write advances the version out from under the open editor.
    // The editor does NOT follow it — that controller is gone — so it still shows the
    // baseline bytes it opened with.
    const current = await requestJson<{ version: string }>(`/documents/${createdDocument!.id}/content`)
    const competingExternal = "Heading\n=======\n\nreal external competing edit\n"
    await requestJson(`/documents/${createdDocument!.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": current.version },
      body: JSON.stringify({ markdown: competingExternal }),
    })
    expect(await fs.readFile(canonical, "utf8")).toBe(competingExternal)
    await expect(source).toHaveValue(baseline)
    await proveGeometry(page, source, testInfo, "real-external-write-does-not-live-refresh")

    // The human edits the stale editor and saves; the stale If-Match is rejected and
    // both sides are preserved in the conflict UI.
    const dirtyDraft = "Heading\n=======\n\nhuman unsaved draft\n"
    await source.fill(dirtyDraft)
    await expect(page.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible()
    await page.keyboard.press("ControlOrMeta+s")
    const conflict = page
      .getByRole("alert")
      .filter({ has: page.getByRole("heading", { name: "Document changed on disk" }) })
    await expect(conflict).toBeVisible({ timeout: 20_000 })
    await conflict.getByText("Compare versions").click()
    await expect(conflict.getByLabel("Your draft")).toContainText("human unsaved draft")
    await expect(conflict.getByLabel("Current disk version")).toContainText("real external competing edit")
    expect(await fs.readFile(canonical, "utf8")).toBe(competingExternal)
    await proveGeometry(page, conflict, testInfo, "real-dirty-cas-conflict-preserves-both-sides")

    await conflict.getByRole("button", { name: "Reload disk" }).click()
    source = await sourceEditor(page)
    await expect(source).toHaveValue(competingExternal)
    // Two snapshots are now labeled "Edited": this test's own competing write
    // (index 0, newest-first) and the baseline the restart test saved before it
    // (index 1). Text-filtering on the "Edited" label alone is ambiguous once a
    // second edit exists — resolve the target by content hash instead, the same
    // way the parked-conflict restore later in this file does.
    const snapshots = await requestJson<Array<{ id: string; sha256: string }>>(
      `/documents/${createdDocument!.id}/snapshots`,
    )
    const baselineSnapshot = snapshots.findIndex(
      (snapshot) => snapshot.sha256 === createHash("sha256").update(baseline).digest("hex"),
    )
    expect(baselineSnapshot).toBeGreaterThanOrEqual(0)
    await page.getByLabel("More", { exact: true }).click()
    const versions = page.getByRole("list", { name: "Document versions" })
    await expect(versions).toBeVisible()
    const savedVersion = versions.getByRole("listitem").nth(baselineSnapshot)
    await expect(savedVersion).toBeVisible()
    await savedVersion.getByRole("button", { name: "Restore" }).click()
    await expect(source).toHaveValue(baseline)
    expect(await fs.readFile(canonical, "utf8")).toBe(baseline)
    await proveGeometry(page, source, testInfo, "real-version-restored-exact-bytes")
  })

  test("/docs inserts a compact document reference before a session exists", async ({ page }) => {
    expect(createdDocument).toBeTruthy()
    await seedProject(page)
    await page.goto(`/w/${encodeURIComponent(workspace)}/session`)
    const composer = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await composer.fill("/docs")
    await page.getByRole("listbox").last().getByRole("option", { name: /\/docs/ }).click()
    const picker = page.getByRole("listbox", { name: "Documents" })
    await expect(picker).toBeVisible()
    await picker.getByRole("option", { name: new RegExp(createdDocument!.display_name) }).click()
    await expect(composer).toContainText(`claxedo://document/${createdDocument!.id}`)
    await expect(composer).not.toContainText(".claxedo/sessions")
  })

  test("/docs reference resolves to a real session tool path; bash write-back, parked write-back, CAS dirty recovery on save, and restore retain identity", async ({
    page,
  }, testInfo) => {
    expect(createdDocument).toBeTruthy()
    const preAgent = "Heading\n=======\n\nreal managed bytes survive restart\n"
    const session = await createSession()
    await seedProject(page)

    await page.goto(`/w/${encodeURIComponent(workspace)}/session/${encodeURIComponent(session.id)}`)
    const composer = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await composer.fill("/docs")
    const slash = page.getByRole("listbox").last()
    await expect(slash).toBeVisible()
    await slash.getByRole("option", { name: /\/docs/ }).click()
    const picker = page.getByRole("listbox", { name: "Documents" })
    await expect(picker).toBeVisible()
    const option = picker.getByRole("option", { name: new RegExp(createdDocument!.display_name) })
    await expect(option).toBeVisible({ timeout: 30_000 })
    await option.click()
    await expect(composer).toContainText(`claxedo://document/${createdDocument!.id}`)
    const opened = await requestJson<{ path: string }>(`/documents/${createdDocument!.id}/agent-open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: session.id }),
    })
    const grantedPath = opened.path
    expect(await fs.realpath(grantedPath)).toBe(grantedPath)
    expect(grantedPath).toContain(
      `${path.sep}.claxedo${path.sep}sessions${path.sep}${session.id}${path.sep}docs${path.sep}${createdDocument!.id}`,
    )
    await proveGeometry(page, composer, testInfo, "real-docs-reference-resolves-honest-session-file")

    await page.goto(documentUrl(createdDocument!.id))
    let editor = await sourceEditor(page)
    await expect(editor).toHaveValue(preAgent)

    const agentEdit = "Heading\n=======\n\nreal agent ordinary bash edit\n"
    await runGrantedPathBash(grantedPath, agentEdit)
    // The agent's bash write-back reaches durable storage, but the open editor no
    // longer live-refreshes to follow it (external-change removed) — it still
    // shows the bytes it opened with.
    expect((await requestJson<{ markdown: string }>(`/documents/${createdDocument!.id}/content`)).markdown).toBe(
      agentEdit,
    )
    await expect(editor).toHaveValue(preAgent)
    await proveGeometry(page, editor, testInfo, "real-agent-bash-does-not-live-refresh-open-editor")

    const dirtyDraft = "Heading\n=======\n\nhuman draft during agent session\n"
    await editor.fill(dirtyDraft)
    await expect(page.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible()
    const current = await requestJson<{ version: string }>(`/documents/${createdDocument!.id}/content`)
    const durableWinner = "Heading\n=======\n\nnewer durable winner\n"
    await requestJson(`/documents/${createdDocument!.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": current.version },
      body: JSON.stringify({ markdown: durableWinner }),
    })
    // The editor opened against a now-stale version, so its save is the moment the
    // divergence surfaces — as a CAS conflict, not a silent overwrite.
    await page.keyboard.press("ControlOrMeta+s")
    const conflict = page
      .getByRole("alert")
      .filter({ has: page.getByRole("heading", { name: "Document changed on disk" }) })
    await expect(conflict).toBeVisible({ timeout: 30_000 })

    const parkedAgentDraft = "Heading\n=======\n\nparked stale-base agent draft\n"
    await runGrantedPathBash(grantedPath!, parkedAgentDraft)
    await expect.poll(async () => await fs.readFile(grantedPath!, "utf8"), { timeout: 30_000 }).toBe(parkedAgentDraft)
    const manifestPath = path.join(path.dirname(path.dirname(grantedPath!)), "manifest.json")
    await expect
      .poll(
        async () => {
          const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
            documents?: Array<{ documentId?: string; state?: string }>
          }
          return manifest.documents?.find((document) => document.documentId === createdDocument!.id)?.state
        },
        { timeout: 30_000 },
      )
      .toBe("conflicted")
    expect((await requestJson<{ markdown: string }>(`/documents/${createdDocument!.id}/content`)).markdown).toBe(
      durableWinner,
    )
    await conflict.getByText("Compare versions").click()
    await expect(conflict.getByLabel("Your draft")).toContainText("human draft during agent session")
    await expect(conflict.getByLabel("Current disk version")).toContainText("newer durable winner")
    await proveGeometry(
      page,
      conflict,
      testInfo,
      "real-dirty-conflict-and-parked-session-copy-preserve-all-versions",
    )

    await conflict.getByRole("button", { name: "Reload disk" }).click()
    editor = await sourceEditor(page)
    await expect(editor).toHaveValue(durableWinner)
    const snapshots = await requestJson<Array<{ id: string; sha256: string }>>(`/documents/${createdDocument!.id}/snapshots`)
    const preAgentSnapshot = snapshots.findIndex(
      (snapshot) => snapshot.sha256 === createHash("sha256").update(preAgent).digest("hex"),
    )
    expect(preAgentSnapshot).toBeGreaterThanOrEqual(0)
    await page.getByLabel("More", { exact: true }).click()
    const versions = page.getByRole("list", { name: "Document versions" })
    await expect(versions).toBeVisible()
    await versions.getByRole("listitem").nth(preAgentSnapshot).getByRole("button", { name: "Restore" }).click()
    await expect(editor).toHaveValue(preAgent)
    await proveGeometry(page, editor, testInfo, "real-pre-agent-version-restored-after-parked-conflict")

    await saveSource(page, "Heading\n=======\n\nhuman continues after real agent\n")
    expect((await listDocuments()).filter((document) => document.id === createdDocument!.id)).toHaveLength(1)
    await proveGeometry(page, editor, testInfo, "real-human-follow-up-retains-document-identity")
  })

  test("repository file deleted externally renders an actionable EC-C1 recovery state", async ({ page }, testInfo) => {
    const relativePath = "docs/repository-recovery.md"
    await fs.mkdir(path.join(workspace, "docs"), { recursive: true })
    await fs.writeFile(path.join(workspace, relativePath), "# Repository recovery\n")
    await execFileAsync("git", ["add", relativePath], { cwd: workspace })
    await execFileAsync(
      "git",
      ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "add recovery document"],
      { cwd: workspace },
    )
    const repository = await requestJson<DocumentSummary>("/documents/from-repo", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-directory": workspace },
      body: JSON.stringify({
        directory: workspace,
        workspace_id: workspaceId,
        path: relativePath,
        display_name: "Repository recovery",
      }),
    })
    await fs.unlink(path.join(workspace, relativePath))

    await seedProject(page)
    await page.goto(documentUrl(repository.id))
    const recovery = page.getByRole("alert")
    await expect(recovery).toBeVisible({ timeout: 30_000 })
    await expect(recovery.getByRole("heading", { name: "Document not found" })).toBeVisible()
    await expect(recovery.getByRole("button", { name: "Try again" })).toBeVisible()
    await expect(recovery.getByRole("button", { name: "Back to Documents" })).toBeVisible()
    await proveGeometry(page, recovery, testInfo, "real-repository-deleted-recovery-state")
  })
})
