/**
 * SPEC: Documents core — deterministic browser proof
 *
 * PURPOSE — prove the complete Documents user contract in the real Claxedo UI while a
 * deterministic HTTP adapter controls durable index/placement state separately from
 * disposable runtime objects, filesystem versions, snapshots, repository
 * identity, agent hydration, and hosted placement. This is Tier M
 * browser evidence: the application, editor, routing, controller, and network contracts
 * are real; the backing server is simulated in this file. Server filesystem atomicity,
 * Git locking, object-store durability, and actual agent tool execution remain Tier L
 * evidence and must be reported separately from this suite.
 *
 * STATE MODEL — an indexed document has content-free metadata plus a versioned Markdown
 * file. Managed files survive checkout loss because their placement is the Documents
 * data directory. Repository files retain repository identity and are edited in place.
 * Opening is read-only. Human edits move idle → dirty → saving → saved; transport errors
 * move saving → failed → retry; stale If-Match moves saving → conflicted while retaining
 * both draft and disk values. An open editor does NOT live-refresh on an external write
 * (that controller was removed): the divergence surfaces as a CAS
 * conflict on the next save. Every accepted write snapshots the previous bytes, and restoration is an
 * explicit history action. Agent access hydrates the canonical file into a session path;
 * an ordinary file-tool write conditionally writes back to the indexed placement. Hosted
 * writes persist in object placement independently of the disposable hydrated VM path.
 *
 * ANATOMY — the index is `main[aria-labelledby=documents-index-title]` with a
 * `ul[aria-label=Documents]`; the editor is `main[aria-label=Document editor]`; rich and
 * source modes expose `Document rich editor` and `Document Markdown source`; persistence
 * is the editor's live `role=status`; conflicts are `role=alert` headed “Document changed
 * on disk” with Reload disk, Save as copy, Overwrite, and Compare versions; history is the
 * editor's “More” popover titled “Version history”, containing `ul[aria-label=Document
 * versions]`; `/docs`
 * opens `role=listbox[aria-label=Documents]` in the session composer.
 *
 * BEHAVIORS —
 *   1. A managed document can be created, edited as exact Markdown, reopened after a
 *      simulated app restart and checkout loss, and retains identical bytes.
 *   2. Repository intake stores only path metadata, reads/writes repository bytes in
 *      place, and never creates a managed-content copy.
 *   3. Opening and closing without an edit performs no write; unsupported Markdown opens
 *      in source mode with an explicit reason and exact bytes.
 *   4. Autosave reports unsaved/saving/saved truthfully; a failed save remains actionable
 *      and Retry recovers without dropping the draft. Rich-editor typing survives its
 *      own autosave event without remounting or switching modes.
 *   5. Two stale tabs cannot silently overwrite one another: CAS conflict UI preserves
 *      both the human draft and current disk value.
 *   6. An external write does not live-refresh an open editor; a competing write is caught
 *      as a CAS conflict on the human's next save and preserves both sides. Out-of-contract
 *      Markdown lands in source mode on reopen and the previous snapshot is restored through
 *      the visible history UI.
 *   7. Version restore is If-Match guarded and replaces the editor with the selected
 *      immutable snapshot.
 *   8. `/docs` resolves one selected document to an honest hydrated path; a causally
 *      subsequent mock file-tool edit conditionally writes back to the indexed placement
 *      and is seen on reopen (no live-refresh). Reopen, snapshot restore, follow-up, and
 *      human save retain the same identity.
 *   9. Locally emulated hosted placement survives disposal of its hydrated VM path; a
 *       reopened editor reads the object-placement value.
 *
 * INVARIANTS — list responses never contain Markdown; every PUT carries If-Match; a 409
 * never mutates server bytes; open/close never writes; geometric proof requires non-zero
 * bounds inside the viewport and a center-point hit test; every claimed visual state is
 * captured under the Playwright test's output directory for independent vision review.
 *
 * HARNESS NOTES — tests carry an `evidence-tier=mock-ui` annotation. `installMockRuntime`
 * owns the surrounding shell/session APIs; `DocumentRuntime` owns only `/documents/**`.
 * There is no document event stream any more (removed with external-change);
 * external writes only mutate durable state. “agent edit”, “restart”, “checkout loss”, and “VM loss” here validate
 * browser and wire behavior, not operating-system or deployment durability. WorkGraph
 * exact fetch/pin is companion D10 server contract evidence rather than a browser success
 * behavior because no browser UI owns that direct route. A D14 release verdict must pair
 * this file with claxedo-server conformance, the real local-session transcript (including
 * actual harness file-tool execution), hosted emulator/staged smoke, and vision review.
 *
 * OUT OF SCOPE — filesystem crash atomicity, symlink races, actual Git commands, a real
 * model invoking bash, real R2 credentials, relay capability security, and visual verdict
 * authorship. Those are D1/D4/D8/D11/D12 and the separate D14 vision-review step.
 */
import { createHash } from "node:crypto"
import { expect, test, type Locator, type Page, type Route, type TestInfo } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-documents-core"
const PROJECT_ID = "proj_documents_core"
const SESSION_ID = "ses_documents_core"
const INDEX_URL = `/w/${PROJECT_ID}/page/__index__`

type Summary = {
  id: string
  project_id: string
  display_name: string
  origin_kind: "managed" | "repository"
  placement_kind: "local" | "hosted"
  placement_id: string
  managed_relative_path: string | null
  repository_id: string | null
  workspace_id: string | null
  repository_relative_path: string | null
  branch: string | null
  status: string
  session_id: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
  last_opened_at: string | null
  last_known_file_version: string | null
}

type StoredSnapshot = {
  id: string
  markdown: string
  displayName: string
  sha256: string
  size: number
  reason: string
  actor: { type: "user" | "agent" | "system"; id: string }
  createdAt: number
  pins: string[]
}

type StoredDocument = {
  summary: Summary
  markdown: string
  version: string
  modifiedAt: number
  snapshots: StoredSnapshot[]
}

type DurableDocument = Omit<StoredDocument, "markdown">

type HydratedAgentFile = {
  documentId: string
  bytes: string
  expectedVersion: string
}

type RequestLog = {
  method: string
  pathname: string
  body?: unknown
  ifMatch?: string
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

function error(route: Route, status: number, code: string, message: string) {
  return json(route, { error: { code, message } }, status)
}

function documentUrl(id: string) {
  return `/w/${PROJECT_ID}/page/${encodeURIComponent(id)}`
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

class DocumentRuntime {
  readonly documents = new Map<string, StoredDocument>()
  readonly durableIndex = new Map<string, DurableDocument>()
  readonly requests: RequestLog[] = []
  readonly repositoryFiles = new Map<string, string>()
  readonly managedFiles = new Map<string, string>()
  readonly hostedObjects = new Map<string, string>()
  readonly hydratedAgentFiles = new Map<string, HydratedAgentFile>()
  readonly hostedVmFiles = new Map<string, HydratedAgentFile>()
  private nextDocument = 1
  private nextSnapshot = 1
  private nextVersion = 1
  private savesFail = false
  private saveLatency = 0

  seed(input: {
    id?: string
    displayName: string
    markdown: string
    origin?: "managed" | "repository"
    placement?: "local" | "hosted"
    repositoryPath?: string
  }) {
    const id = input.id ?? `document_${this.nextDocument++}`
    const now = new Date().toISOString()
    const origin = input.origin ?? "managed"
    const placement = input.placement ?? "local"
    const summary: Summary = {
      id,
      project_id: PROJECT_ID,
      display_name: input.displayName,
      origin_kind: origin,
      placement_kind: placement,
      placement_id: placement === "hosted" ? "bucket_documents_core" : DIR,
      managed_relative_path: origin === "managed" ? `${id}/${evidenceName(input.displayName)}.md` : null,
      repository_id: origin === "repository" ? "repo_documents_core" : null,
      workspace_id: origin === "repository" ? DIR : null,
      repository_relative_path: origin === "repository" ? (input.repositoryPath ?? "docs/plan.md") : null,
      branch: origin === "repository" ? "dev" : null,
      status: "draft",
      session_id: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
      last_opened_at: null,
      last_known_file_version: this.version(),
    }
    const document = {
      summary,
      markdown: input.markdown,
      version: summary.last_known_file_version!,
      modifiedAt: Date.now(),
      snapshots: [],
    }
    this.documents.set(id, document)
    this.writePlacement(document)
    this.persistMetadata(document)
    return document
  }

  async install(page: Page) {
    await page.route("**/documents**", (route) => this.handle(route))
  }

  failSaves(value: boolean) {
    this.savesFail = value
  }

  delaySaves(milliseconds: number) {
    this.saveLatency = milliseconds
  }

  inspect(id: string) {
    return this.require(id)
  }

  contentWrites(id?: string) {
    return this.requests.filter(
      (request) => request.method === "PUT" && request.pathname === `/documents/${id ?? ""}/content`,
    )
  }

  // Mutates the durable document as if something wrote the file out of band.
  // There is no live-refresh notification anymore (the `/documents/events` SSE
  // and the editor's external-change controller were removed): an open editor
  // stays put, and the divergence surfaces as a CAS conflict the next time
  // that editor saves.
  externalEdit(id: string, markdown: string, actor: "agent" | "user" = "agent") {
    const document = this.require(id)
    this.snapshot(document, `before ${actor} edit`, { type: actor, id: `${actor}_documents_core` })
    document.markdown = markdown
    document.version = this.version()
    document.modifiedAt = Date.now()
    document.summary.last_known_file_version = document.version
    document.summary.updated_at = new Date().toISOString()
    this.writePlacement(document)
    this.persistMetadata(document)
  }

  hydrateForAgent(id: string, sessionId: string) {
    const document = this.require(id)
    const path = `${DIR}/.claxedo/sessions/${sessionId}/docs/${id}/${evidenceName(document.summary.display_name)}.md`
    const file = { documentId: id, bytes: document.markdown, expectedVersion: document.version }
    const files = document.summary.placement_kind === "hosted" ? this.hostedVmFiles : this.hydratedAgentFiles
    files.set(path, file)
    document.summary.session_id = sessionId
    this.persistMetadata(document)
    return path
  }

  async runAgentFileTool(path: string, bytes: string) {
    const file = this.hydratedAgentFiles.get(path) ?? this.hostedVmFiles.get(path)
    if (!file) throw new Error("Agent file writes require a preceding document agent-open hydration.")
    const document = this.require(file.documentId)
    if (file.expectedVersion !== document.version) throw new Error("Agent hydrated file is stale.")
    file.bytes = bytes
    this.snapshot(document, "before agent edit", { type: "agent", id: "agent_documents_core" })
    document.markdown = file.bytes
    document.version = this.version()
    document.modifiedAt = Date.now()
    document.summary.last_known_file_version = document.version
    document.summary.updated_at = new Date().toISOString()
    this.writePlacement(document)
    this.persistMetadata(document)
    file.expectedVersion = document.version
  }

  deleteCheckout() {
    this.repositoryFiles.clear()
  }

  restartApp() {
    // Volatile HTTP objects are discarded. Durable index metadata and placement bytes
    // independently reconstruct fresh objects and their opaque versions.
    this.documents.clear()
    this.durableIndex.forEach((_metadata, id) => this.reconstruct(id))
  }

  disposeHostedVm(id: string) {
    const document = this.require(id)
    expect(document.summary.placement_kind).toBe("hosted")
    this.hostedVmFiles.forEach((file, path) => {
      if (file.documentId === id) this.hostedVmFiles.delete(path)
    })
    this.documents.delete(id)
  }

  private version() {
    return `opaque-v${this.nextVersion++}`
  }

  private require(id: string) {
    const document = this.documents.get(id)
    if (document) return document
    return this.reconstruct(id)
  }

  private reconstruct(id: string) {
    const metadata = this.durableIndex.get(id)
    if (!metadata) throw new Error(`Missing document ${id}`)
    const document = {
      summary: { ...metadata.summary },
      markdown: this.readPlacement(metadata.summary),
      version: metadata.version,
      modifiedAt: metadata.modifiedAt,
      snapshots: metadata.snapshots.map((snapshot) => ({
        ...snapshot,
        actor: { ...snapshot.actor },
        pins: [...snapshot.pins],
      })),
    } satisfies StoredDocument
    this.documents.set(id, document)
    return document
  }

  private placementKey(document: StoredDocument) {
    return document.summary.repository_relative_path ?? document.summary.managed_relative_path ?? document.summary.id
  }

  private writePlacement(document: StoredDocument) {
    const files =
      document.summary.origin_kind === "repository"
        ? this.repositoryFiles
        : document.summary.placement_kind === "hosted"
          ? this.hostedObjects
          : this.managedFiles
    files.set(this.placementKey(document), document.markdown)
  }

  private readPlacement(summary: Summary) {
    const key = summary.repository_relative_path ?? summary.managed_relative_path ?? summary.id
    const files =
      summary.origin_kind === "repository"
        ? this.repositoryFiles
        : summary.placement_kind === "hosted"
          ? this.hostedObjects
          : this.managedFiles
    const bytes = files.get(key)
    if (bytes === undefined) throw new Error(`Missing durable placement bytes for ${summary.id}`)
    return bytes
  }

  private persistMetadata(document: StoredDocument) {
    this.durableIndex.set(document.summary.id, {
      summary: { ...document.summary },
      version: document.version,
      modifiedAt: document.modifiedAt,
      snapshots: document.snapshots.map((snapshot) => ({
        ...snapshot,
        actor: { ...snapshot.actor },
        pins: [...snapshot.pins],
      })),
    })
  }

  private snapshot(
    document: StoredDocument,
    reason: string,
    actor: StoredSnapshot["actor"] = { type: "user", id: "user_documents_core" },
  ) {
    const snapshot: StoredSnapshot = {
      id: `snapshot_${this.nextSnapshot++}`,
      markdown: document.markdown,
      displayName: document.summary.display_name,
      sha256: sha256(document.markdown),
      size: Buffer.byteLength(document.markdown),
      reason,
      actor,
      createdAt: Date.now(),
      pins: [],
    }
    document.snapshots.unshift(snapshot)
    return snapshot
  }

  private publicSnapshot(snapshot: StoredSnapshot) {
    const { markdown: _markdown, displayName: _displayName, ...publicValue } = snapshot
    return publicValue
  }

  private content(document: StoredDocument) {
    return { markdown: document.markdown, version: document.version, modifiedAt: document.modifiedAt }
  }

  private async handle(route: Route) {
    const request = route.request()
    const url = new URL(request.url())
    if (!url.pathname.startsWith("/documents")) return route.fallback()
    const body = request.postData() ? request.postDataJSON() : undefined
    this.requests.push({
      method: request.method(),
      pathname: url.pathname,
      ...(body === undefined ? {} : { body }),
      ...(request.headers()["if-match"] ? { ifMatch: request.headers()["if-match"] } : {}),
    })

    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
    // The `/documents/events` SSE route was removed with external-change;
    // the client never opens it, so there is nothing to mock here.
    if (request.method() === "GET" && parts[1] === "statuses") {
      return json(route, [{ id: "draft", name: "Draft", color: "gray", position: 0, transitions: [] }])
    }
    if (request.method() === "GET" && parts.length === 1) {
      const rows = [...this.durableIndex.values()].map((document) => ({ ...document.summary }))
      return json(route, rows)
    }
    if (request.method() === "POST" && parts.length === 1) {
      const input = body as { project_id?: string; display_name: string; markdown?: string }
      const document = this.seed({ displayName: input.display_name, markdown: input.markdown ?? "" })
      return json(route, document.summary, 201)
    }
    if (request.method() === "POST" && parts[1] === "from-repo") {
      const input = body as { display_name?: string; path: string }
      const markdown = this.repositoryFiles.get(input.path) ?? ""
      const document = this.seed({
        displayName: input.display_name ?? input.path.split("/").at(-1)?.replace(/\.md$/i, "") ?? "Repository document",
        markdown,
        origin: "repository",
        repositoryPath: input.path,
      })
      return json(route, document.summary, 201)
    }

    const id = parts[1]
    const document = id && this.durableIndex.has(id) ? this.require(id) : undefined
    if (!document) return error(route, 404, "document_not_found", "Document not found")
    if (request.method() === "GET" && parts.length === 2) return json(route, document.summary)
    if (request.method() === "GET" && parts[2] === "content") return json(route, this.content(document))
    if (request.method() === "PUT" && parts[2] === "content") {
      if (this.saveLatency) await new Promise((resolve) => setTimeout(resolve, this.saveLatency))
      if (this.savesFail) return error(route, 503, "document_write_failed", "Simulated storage outage")
      if (request.headers()["if-match"] !== document.version)
        return error(route, 409, "document_version_conflict", "Document changed on disk")
      const input = body as { display_name: string; markdown: string }
      this.snapshot(document, "before save")
      document.summary.display_name = input.display_name
      document.markdown = input.markdown
      document.version = this.version()
      document.modifiedAt = Date.now()
      document.summary.updated_at = new Date().toISOString()
      document.summary.last_known_file_version = document.version
      this.writePlacement(document)
      this.persistMetadata(document)
      return json(route, this.content(document))
    }
    if (request.method() === "POST" && parts[2] === "agent-open") {
      const path = this.hydrateForAgent(id, (body as { session_id: string }).session_id)
      return json(route, {
        document_id: id,
        display_name: document.summary.display_name,
        path,
      })
    }
    if (request.method() === "GET" && parts[2] === "snapshots") {
      return json(
        route,
        document.snapshots.map((snapshot) => this.publicSnapshot(snapshot)),
      )
    }
    if (request.method() === "POST" && parts[2] === "snapshots" && parts[4] === "restore") {
      if (request.headers()["if-match"] !== document.version)
        return error(route, 409, "document_version_conflict", "Document changed before restore")
      const selected = document.snapshots.find((snapshot) => snapshot.id === parts[3])
      if (!selected) return error(route, 404, "document_snapshot_not_found", "Snapshot not found")
      this.snapshot(document, "before restore")
      document.markdown = selected.markdown
      document.summary.display_name = selected.displayName
      document.version = this.version()
      document.modifiedAt = Date.now()
      document.summary.last_known_file_version = document.version
      this.writePlacement(document)
      this.persistMetadata(document)
      return json(route, this.content(document))
    }
    if (request.method() === "POST" && parts[2] === "work-source") {
      const snapshot = this.snapshot(document, "workgraph.ingest")
      const input = body as { target_stream_id?: string; directory?: string; repository_url?: string }
      return json(route, {
        locator: {
          projectId: document.summary.project_id,
          documentId: id,
          snapshotId: snapshot.id,
          placement: document.summary.placement_kind,
          ...(input.target_stream_id ? { targetStreamId: input.target_stream_id } : {}),
          ...(input.directory ? { directory: input.directory } : {}),
          ...(input.repository_url ? { repositoryUrl: input.repository_url } : {}),
        },
        documentTitle: document.summary.display_name,
        markdown: snapshot.markdown,
        contentHash: snapshot.sha256,
        authoredAt: snapshot.createdAt,
        authoredBy: snapshot.actor,
      })
    }
    if (request.method() === "POST" && parts[2] === "snapshots" && parts[4] === "work-source-pin") {
      const selected = document.snapshots.find((snapshot) => snapshot.id === parts[3])
      if (!selected) return error(route, 404, "document_snapshot_not_found", "Snapshot not found")
      const input = body as { work_source_id: string; revision_id: string }
      selected.pins.push(`workgraph:${input.work_source_id}:${input.revision_id}`)
      return json(route, this.publicSnapshot(selected))
    }
    return error(route, 404, "document_route_not_found", "Document route not found")
  }
}

async function bootstrap(page: Page, runtime: DocumentRuntime) {
  await installMockRuntime(page, {
    dir: DIR,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    workspaceId: PROJECT_ID,
  })
  await runtime.install(page)
  await page.addInitScript(
    ({ dir, projectId }: { dir: string; projectId: string }) => {
      localStorage.clear()
      ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
        serverUrl: window.location.origin,
        activeDirectory: dir,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: { local: [{ id: projectId, worktree: dir, workspaceId: projectId, expanded: true }] },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
    },
    { dir: DIR, projectId: PROJECT_ID },
  )
}

async function openIndex(page: Page) {
  await page.goto(INDEX_URL)
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible({ timeout: 30_000 })
}

async function openDocument(page: Page, id: string) {
  await page.goto(documentUrl(id))
  await expect(page.getByRole("main", { name: "Document editor" })).toBeVisible({ timeout: 30_000 })
}

// Legacy base64 directory-slug route (`legacyDirectoryRouteKey` in
// src/platform/identity/route.ts). Used only to reach a draft session view so
// the workbench shell (with its per-pane "Open Files" toggle) mounts — the
// same pattern core-composer-modes.spec.ts's `openDraftPrompt` and
// core-cloud-offline-roles.spec.ts's `gotoDraft` already rely on.
function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function openDraftSession(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`, { waitUntil: "domcontentloaded" })
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-component="prompt-input"]').last()).toBeVisible({ timeout: 20_000 })
}

// Mirrors core-cloud-offline-roles.spec.ts's `openWorkspaceNavigator` helper —
// the workspace panel may already be open (skip the opener) or closed
// (open it first), then toggle to the named navigator.
async function openWorkspaceNavigator(page: Page, navigator: "Files" | "Changes" | "Processes") {
  const openPanel = page.getByRole("button", { name: "Open workspace panel", exact: true }).first()
  if (await openPanel.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await openPanel.click({ timeout: 5_000 }).catch(() => {})
  }
  const control = page.locator(`button[aria-label="Open ${navigator}"], button[aria-label="Close ${navigator}"]`).last()
  await expect(control).toBeVisible({ timeout: 10_000 })
  if ((await control.getAttribute("aria-pressed")) !== "true") await control.click()
  await expect(control).toHaveAttribute("aria-pressed", "true")
}

// The real per-file flow reads the repo file's own bytes over the file API
// before "Add to Documents" ever runs (src/app/workbench/content/tab-file.tsx
// -> sdk.client.file.read). `installMockRuntime` only stubs `/file**` under
// the relay (cloud) origin; local-mode specs like this one get no file-API
// mock at all, so this file backs GET /file (tree list), /file/status, and
// /file/content with the same `repositoryFiles` map DocumentRuntime already
// uses for `/documents/from-repo` and the indexed document's placement I/O —
// one source of truth for "what's on disk" across both APIs.
const FILE_API_PATHS = new Set(["/file", "/file/status", "/file/content", "/find", "/find/file", "/find/symbol"])

async function installRepositoryFilesystem(page: Page, files: Map<string, string>) {
  // Matched by an exact-pathname predicate, NOT a `**/file**` glob: this local
  // dev/preview server also serves build assets (chunk/source-map filenames
  // routinely contain the substring "file"), so a broad glob risks swallowing
  // an unrelated asset request and blanking the whole app boot.
  await page.route(
    (url) => FILE_API_PATHS.has(url.pathname),
    (route) => {
      const request = route.request()
      if (request.method() !== "GET") return route.fallback()
      const url = new URL(request.url())
      if (url.pathname === "/file/content") {
        const path = url.searchParams.get("path") ?? ""
        const content = files.get(path)
        if (content === undefined) return error(route, 404, "file_not_found", "File not found")
        return json(route, { type: "text", content })
      }
      if (url.pathname === "/file/status") return json(route, [])
      if (url.pathname === "/file") {
        const path = url.searchParams.get("path") ?? ""
        if (path !== "") return json(route, [])
        const entries = [...files.keys()].map((filePath) => ({
          name: filePath.split("/").at(-1)!,
          path: filePath,
          absolute: `${DIR}/${filePath}`,
          type: "file" as const,
          ignored: false,
        }))
        return json(route, entries)
      }
      return json(route, [])
    },
  )
}

async function sourceEditor(page: Page) {
  const source = page.getByLabel("Document Markdown source")
  await expect(source).toBeVisible()
  return source
}

async function saveSource(page: Page, markdown: string) {
  const source = await sourceEditor(page)
  await source.fill(markdown)
  await page.keyboard.press("ControlOrMeta+s")
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible()
  return source
}

function annotate(testInfo: TestInfo, extra = "") {
  testInfo.annotations.push({
    type: "evidence-tier",
    description: `Tier M mock-backed real UI proof${extra ? `; ${extra}` : ""}`,
  })
}

function unexpectedCanaryConsoleErrors(messages: string[]) {
  // The document `/documents/events` SSE is gone, so its
  // reconnect noise no longer needs an exemption. The central events stream
  // (`GET /api/wr/events`) still churns under this deterministic harness: per
  // core-sidebar-tree.spec.ts's documented shared-helper gap, `installMockRuntime`
  // only mocks that route under the relay origin (`options.cloud`) — the default
  // local-mode path here is never intercepted, so it genuinely fails to connect
  // to a real backend and retries. That surfaces THREE distinct noise shapes
  // under sustained failure: the browser's own "Failed to load resource" console
  // noise, `console.error("[global-sdk] event stream failed", ...)`
  // (src/app/providers/global-sdk/provider.tsx:682), and
  // `console.error("[claxedo-events] stream failed", ...)`
  // (src/app/integrations/claxedo-events.tsx) — two independently-escalating
  // event-stream consumers, not one. Filtered the same way this identical
  // unmocked-central-origin noise is filtered in
  // core-boot-deep-links-home.spec.ts's `nonClerkConsole`.
  return messages.filter(
    (message) =>
      !message.includes("Failed to load resource") &&
      !message.startsWith("[claxedo-events] stream failed") &&
      !message.startsWith("[global-sdk] event stream failed") &&
      !message.startsWith("[global-sdk] runtime event stream failed"),
  )
}

function unexpectedCanaryRequestFailures(urls: string[]) {
  // Same unmocked-central-origin gap as `unexpectedCanaryConsoleErrors` above:
  // beyond the events stream, background inventory polling this canary
  // incidentally triggers (`/api/control/sessions`, `/project/current`,
  // `/project/:id`, ...) is not covered by `installMockRuntime` either and
  // genuinely hits (and fails against) the real 127.0.0.1:3001 backend this
  // Tier-M harness never runs. Filtered by origin, the same broad-brush way
  // core-boot-deep-links-home.spec.ts's `fromUnmockedCentralOrigin` filters
  // this identical class of noise, rather than chasing an ever-growing
  // pathname allow-list.
  return urls.filter((value) => {
    const pathname = new URL(value).pathname
    if (["/api/wr/events", "/global/event", "/event"].includes(pathname)) return false
    return !value.includes("127.0.0.1:3001")
  })
}

test.describe.serial("Documents core deterministic journeys @core", () => {
  test("managed create → exact Markdown → restart + checkout loss → exact reopen — behaviors 1,3", async ({
    page,
  }, testInfo) => {
    annotate(testInfo, "restart and checkout-loss storage are simulated")
    const runtime = new DocumentRuntime()
    await bootstrap(page, runtime)
    await openIndex(page)
    const readsBeforeCreate = runtime.requests.filter((request) => request.pathname.endsWith("/content")).length
    // "New document" is a searchable project picker, not a direct-create button
    // (see document-index.tsx's `NewDocumentButton`/`createInProject`: creating a
    // document requires an EXPLICITLY chosen project) — open it, then pick the
    // sole fixture project from its list before a document actually gets created.
    await page.getByRole("button", { name: "New document" }).click()
    await page.locator('.documents-new-list-host [data-slot="list-item"]').first().click()
    await expect(page.getByRole("main", { name: "Document editor" })).toBeVisible()
    const created = [...runtime.documents.values()][0]!
    const exact = "---\ntitle: Exact bytes\n---\n\nManaged\n=======\n\n- alpha\n- beta\n"
    runtime.externalEdit(created.summary.id, exact)
    await openDocument(page, created.summary.id)
    await expect(await sourceEditor(page)).toHaveValue(exact)
    expect(runtime.managedFiles.get(created.summary.managed_relative_path!)).toBe(exact)
    await proveGeometry(page, page.getByRole("main", { name: "Document editor" }), testInfo, "managed-exact-saved")

    runtime.deleteCheckout()
    const volatileBeforeRestart = created
    runtime.restartApp()
    expect(runtime.inspect(created.summary.id)).not.toBe(volatileBeforeRestart)
    expect(runtime.durableIndex.get(created.summary.id)?.version).toBe(runtime.inspect(created.summary.id).version)
    await openIndex(page)
    await expect(page.getByRole("list", { name: "Documents" })).toContainText("Untitled document")
    await page.getByRole("button", { name: /Untitled document/ }).click()
    const reopened = await sourceEditor(page)
    await expect(reopened).toHaveValue(exact)
    expect(runtime.requests.filter((request) => request.pathname.endsWith("/content")).length).toBeGreaterThan(
      readsBeforeCreate,
    )
    await proveGeometry(page, reopened, testInfo, "managed-reopened-after-restart-and-checkout-loss")
  })

  test("repository index is metadata-only and edits file in place without a managed copy — behavior 2", async ({
    page,
  }, testInfo) => {
    // The Documents-index repository importer this behavior originally drove was
    // intentionally removed (commit 76953781d7; document-index.vitest.tsx now
    // asserts the index "does not carry a repository importer"). The contract it
    // proved is unchanged — repository docs are metadata-only, edits land on the
    // real file, never a managed copy — but the entry point moved to the repo
    // file's own tab: open it, then use its "Add to Documents" icon
    // (src/app/workbench/content/tab-file.tsx). See docs/e2e-decisions.md #5.
    annotate(testInfo, "repository filesystem is simulated")
    const runtime = new DocumentRuntime()
    runtime.repositoryFiles.set("repository.md", "Heading\n=======\n\nrepository original\n")
    await bootstrap(page, runtime)
    await installRepositoryFilesystem(page, runtime.repositoryFiles)

    await openDraftSession(page, DIR)
    await openWorkspaceNavigator(page, "Files")
    const fileNode = page.locator('[data-file-tree-path="repository.md"]')
    await expect(fileNode).toBeVisible({ timeout: 20_000 })
    await fileNode.click()

    const addToDocuments = page.getByRole("button", { name: "Add to Documents" })
    await expect(addToDocuments).toBeVisible({ timeout: 20_000 })
    await proveGeometry(page, addToDocuments, testInfo, "repository-file-tab-add-to-documents")
    await addToDocuments.click()

    await expect(page.getByRole("main", { name: "Document editor" })).toBeVisible({ timeout: 30_000 })
    const indexed = [...runtime.documents.values()].find(
      (candidate) => candidate.summary.repository_relative_path === "repository.md",
    )!.summary
    const document = runtime.inspect(indexed.id)
    // No project_id: the per-file flow (review-workspace.tsx's
    // collaborateWithMarkdown) never resolves one — unlike the deleted index
    // importer, it only has directory/workspaceId/path in scope. workspace_id
    // itself resolves to the PROJECT's id, not the raw directory: this fixture
    // project carries no per-directory `workspaces` map (that field is for
    // hybrid/toolSandbox-backed projects only), so collaborateWithMarkdown's
    // `workspace?.workspaceId ?? workspace?.id ?? project?.id` fallback chain
    // bottoms out on the plain local project's own id.
    expect(runtime.requests.find((request) => request.pathname === "/documents/from-repo")?.body).toEqual({
      directory: DIR,
      workspace_id: PROJECT_ID,
      path: "repository.md",
      display_name: "repository.md",
    })
    const contentReadsBeforeIndex = runtime.requests.filter((request) => request.pathname.endsWith("/content")).length
    await openIndex(page)
    await expect(page.getByRole("list", { name: "Documents" })).toContainText("repository.md")
    expect(runtime.requests.filter((request) => request.pathname.endsWith("/content"))).toHaveLength(
      contentReadsBeforeIndex,
    )
    expect(JSON.stringify([...runtime.documents.values()].map((item) => item.summary))).not.toContain(
      "repository original",
    )
    await proveGeometry(page, page.getByRole("list", { name: "Documents" }), testInfo, "repository-metadata-only-index")

    await page.getByRole("button", { name: /repository\.md/ }).click()
    const next = "Heading\n=======\n\nrepository edited in place\n"
    await saveSource(page, next)
    expect(runtime.repositoryFiles.get("repository.md")).toBe(next)
    expect(runtime.managedFiles.has(document.summary.repository_relative_path!)).toBe(false)
    await proveGeometry(page, await sourceEditor(page), testInfo, "repository-edit-in-place")
  })

  test("open-close performs no write and unsupported Markdown falls back to labeled source mode — behavior 3", async ({
    page,
  }, testInfo) => {
    annotate(testInfo)
    const runtime = new DocumentRuntime()
    const supportedBytes =
      "# Supported\n\nExact rich bytes with [link](https://claxedo.com) and `inline`.\n\n## Details\n\n```sh\nnpm test\n```\n"
    const supported = runtime.seed({ id: "supported_document", displayName: "Supported", markdown: supportedBytes })
    const unsupported = "# MDX\n\n<Component answer={42} />\n"
    const document = runtime.seed({ id: "unsupported_document", displayName: "MDX", markdown: unsupported })
    await bootstrap(page, runtime)
    await openDocument(page, supported.summary.id)
    await expect(page.getByRole("textbox", { name: "Document rich editor" })).toBeVisible()
    const richTextColors = await page.locator(".notion-editor .tiptap").evaluate((root) => {
      const color = (selector: string) => getComputedStyle(root.querySelector(selector)!).color
      return {
        prose: color("p"),
        link: color("a"),
        inlineCode: color("p code"),
        codeBlock: color("pre code"),
      }
    })
    expect(new Set(Object.values(richTextColors))).toEqual(new Set([richTextColors.prose]))
    const codeBlock = page.locator(".notion-editor .tiptap pre code")
    await expect(page.getByRole("textbox", { name: "Document rich editor" })).toHaveAttribute("spellcheck", "true")
    await expect(codeBlock).toHaveAttribute("spellcheck", "false")
    await expect(codeBlock).toHaveAttribute("autocorrect", "off")
    await expect(codeBlock).toHaveAttribute("autocapitalize", "off")
    const tocLayout = await page.locator(".notion-toc-wrap").evaluate((toc) => {
      const editor = toc.closest("section")!.querySelector(".tiptap")!
      const scroller = toc.closest(".notion-page-shell")!.parentElement!
      return {
        position: getComputedStyle(toc).position,
        tocTop: toc.getBoundingClientRect().top,
        tocRight: toc.getBoundingClientRect().right,
        editorLeft: editor.getBoundingClientRect().left,
        scrollerTop: scroller.getBoundingClientRect().top,
        scrollerHeight: scroller.getBoundingClientRect().height,
      }
    })
    expect(tocLayout.position).toBe("sticky")
    expect(tocLayout.tocTop - tocLayout.scrollerTop).toBeLessThan(tocLayout.scrollerHeight * 0.4)
    expect(tocLayout.tocRight).toBeLessThan(tocLayout.editorLeft)
    await page.goto(INDEX_URL)
    expect(runtime.contentWrites(supported.summary.id)).toHaveLength(0)
    expect(runtime.managedFiles.get(supported.summary.managed_relative_path!)).toBe(supportedBytes)

    await openDocument(page, document.summary.id)
    await expect(page.getByText("Source mode", { exact: true })).toBeVisible()
    await expect(page.getByText("HTML is outside the rich Markdown contract.", { exact: true })).toBeVisible()
    const source = await sourceEditor(page)
    await expect(source).toHaveValue(unsupported)
    expect(runtime.managedFiles.get(document.summary.managed_relative_path!)).toBe(unsupported)
    expect(runtime.contentWrites(document.summary.id)).toHaveLength(0)
    await proveGeometry(page, source, testInfo, "unsupported-source-fallback")
    await page.goto(INDEX_URL)
    expect(runtime.contentWrites(document.summary.id)).toHaveLength(0)
  })

  test("truthful autosave exhausts bounded retries before manual Retry recovers the preserved draft — behavior 4", async ({
    page,
  }, testInfo) => {
    annotate(testInfo)
    const runtime = new DocumentRuntime()
    const document = runtime.seed({ id: "recovery_document", displayName: "Recovery", markdown: "Heading\n=======\n" })
    await bootstrap(page, runtime)
    await openDocument(page, document.summary.id)
    runtime.failSaves(true)
    runtime.delaySaves(400)
    const source = await sourceEditor(page)
    await source.fill("Heading\n=======\n\nkeep this draft\n")
    await expect(page.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible()
    await expect(page.getByRole("status").filter({ hasText: "Saving" })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole("status").filter({ hasText: "Save failed" })).toBeVisible()
    await expect.poll(() => runtime.contentWrites(document.summary.id).length, { timeout: 15_000 }).toBe(4)
    await expect(source).toHaveValue("Heading\n=======\n\nkeep this draft\n")
    await proveGeometry(
      page,
      page.getByRole("status").filter({ hasText: "Save failed" }),
      testInfo,
      "autosave-failed-actionable",
    )

    runtime.failSaves(false)
    runtime.delaySaves(0)
    await page.getByRole("button", { name: "Retry" }).click()
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible()
    expect(runtime.inspect(document.summary.id).markdown).toBe("Heading\n=======\n\nkeep this draft\n")
    await proveGeometry(page, page.getByRole("status").filter({ hasText: "Saved" }), testInfo, "autosave-retry-saved")
  })

  test("rich editor accepts typing and its autosave event preserves the editor instance — behavior 4 @documents-rich-canary @documents-release-canary", async ({
    page,
    context,
  }, testInfo) => {
    annotate(testInfo, "direct rich-editor input and autosave feedback-loop regression")
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    const requestFailures: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text())
    })
    page.on("requestfailed", (request) => requestFailures.push(request.url()))
    const runtime = new DocumentRuntime()
    // NOT `document`: this test also runs `page.evaluate` callbacks that reference the
    // BROWSER's `document` global. A Node-side local named `document` shadows it for
    // the whole test body — the callbacks still worked at runtime (Playwright
    // serializes them, so `document` resolves in the page), but they typechecked
    // against this seed object instead of the DOM.
    const doc = runtime.seed({ displayName: "Editable rich document", markdown: "# Editable\n\nStart here.\n" })
    await bootstrap(page, runtime)
    await openDocument(page, doc.summary.id)
    const rich = page.getByRole("textbox", { name: "Document rich editor" })
    await expect(page.locator(".notion-page-shell")).toBeVisible()
    await expect(page.getByRole("textbox", { name: "Document name" })).toHaveClass(/notion-title/)
    await expect(rich).toHaveClass(/tiptap/)
    await rich.evaluate((element) => (element.dataset.e2eEditorInstance = "stable"))
    const richHandle = await rich.elementHandle()
    if (!richHandle) throw new Error("Rich editor did not mount")
    await rich.click()
    expect(await rich.evaluate((element) => document.activeElement === element)).toBe(true)
    expect(
      await rich.evaluate((element) => {
        const anchor = getSelection()?.anchorNode
        if (!anchor) return false
        return element.contains(anchor.nodeType === Node.TEXT_NODE ? anchor.parentNode : anchor)
      }),
    ).toBe(true)
    await page.keyboard.press("End")
    await page.keyboard.type(" Typed in rich mode.")
    await expect(page.getByRole("status")).toContainText(/Unsaved changes|Saving/)
    await expect(page.getByRole("status")).toContainText("Saved", { timeout: 10_000 })
    await expect(rich).toContainText("Typed in rich mode.")

    await page.keyboard.press("Enter")
    await page.keyboard.type("Second paragrapx")
    await page.keyboard.press("Backspace")
    await page.keyboard.type("h.")
    await page.keyboard.press("Home")
    await page.keyboard.type("Caret stable: ")
    await page.keyboard.press("End")
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin })
    await page.evaluate(() => navigator.clipboard.writeText(" Pasted"))
    const clipboardModifier = process.platform === "darwin" ? "Meta" : "Control"
    const editorModifier = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control",
    )
    await page.keyboard.press(`${clipboardModifier}+V`)
    expect(await rich.textContent()).toContain("Caret stable: Second paragraph. Pasted")
    await page.keyboard.press(`${editorModifier}+Z`)
    expect(await rich.textContent()).not.toContain("Pasted")
    await page.keyboard.press(`${editorModifier}+Shift+Z`)
    expect(await rich.textContent()).toContain("Caret stable: Second paragraph. Pasted")
    const selectionBeforeSave = await rich.evaluate((element) => {
      const selection = getSelection()
      const anchor = selection?.anchorNode
      return {
        inside: Boolean(anchor && element.contains(anchor.nodeType === Node.TEXT_NODE ? anchor.parentNode : anchor)),
        anchorOffset: selection?.anchorOffset,
        focusOffset: selection?.focusOffset,
        anchorText: anchor?.textContent,
      }
    })
    await expect(page.getByRole("status")).toContainText(/Unsaved changes|Saving/)
    await expect(page.getByRole("status")).toContainText("Saved", { timeout: 10_000 })
    expect(
      await rich.evaluate((element) => {
        const selection = getSelection()
        const anchor = selection?.anchorNode
        return {
          inside: Boolean(anchor && element.contains(anchor.nodeType === Node.TEXT_NODE ? anchor.parentNode : anchor)),
          anchorOffset: selection?.anchorOffset,
          focusOffset: selection?.focusOffset,
          anchorText: anchor?.textContent,
        }
      }),
    ).toEqual(selectionBeforeSave)
    await page.keyboard.type("!")
    await expect(rich).toContainText("Caret stable: Second paragraph. Pasted!")
    await expect(page.getByRole("status")).toContainText("Saved", { timeout: 10_000 })
    await expect(page.getByText("Source mode")).toHaveCount(0)
    expect(await rich.getAttribute("data-e2e-editor-instance")).toBe("stable")
    const richHandleAfterSave = await rich.elementHandle()
    if (!richHandleAfterSave) throw new Error("Rich editor disappeared after autosave")
    expect(await page.evaluate(([before, after]) => before === after, [richHandle, richHandleAfterSave])).toBe(true)
    expect(await rich.evaluate((element) => document.activeElement === element)).toBe(true)
    expect(runtime.inspect(doc.summary.id).markdown).toContain("Caret stable: Second paragraph. Pasted!")
    await proveGeometry(page, rich, testInfo, "rich-editor-stable-after-autosave")

    await openDocument(page, doc.summary.id)
    const reopened = page.getByRole("textbox", { name: "Document rich editor" })
    await expect(reopened).toContainText("Caret stable: Second paragraph. Pasted!")
    await expect(page.getByText("Source mode")).toHaveCount(0)
    expect(pageErrors).toEqual([])
    expect(unexpectedCanaryConsoleErrors(consoleErrors)).toEqual([])
    expect(unexpectedCanaryRequestFailures(requestFailures)).toEqual([])
  })

  test("rich editor preserves formatting and slash-command interactions through autosave @documents-rich-canary @documents-release-canary", async ({
    page,
  }) => {
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    const requestFailures: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text())
    })
    page.on("requestfailed", (request) => requestFailures.push(request.url()))
    const runtime = new DocumentRuntime()
    // NOT `document` — same DOM-global shadowing trap as the test above.
    const doc = runtime.seed({
      displayName: "Rich interaction document",
      markdown: "First paragraph.\n\nSecond paragraph.\n",
    })
    await bootstrap(page, runtime)
    await openDocument(page, doc.summary.id)

    const title = page.getByRole("textbox", { name: "Document name" })
    const rich = page.getByRole("textbox", { name: "Document rich editor" })
    const richHandle = await rich.elementHandle()
    if (!richHandle) throw new Error("Rich editor did not mount")
    await title.focus()
    await page.keyboard.press("Enter")
    expect(await rich.evaluate((element) => document.activeElement === element)).toBe(true)

    await rich.locator("p").first().click()
    const editorModifier = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control",
    )
    await page.keyboard.press(`${editorModifier}+A`)
    expect(await page.evaluate(() => getSelection()?.toString())).toBe("First paragraph.")
    await page.keyboard.press(`${editorModifier}+A`)
    expect(await page.evaluate(() => getSelection()?.toString())).toContain("Second paragraph.")

    await rich.evaluate((element) => {
      const paragraph = element.querySelector("p")
      if (!paragraph) throw new Error("Expected a paragraph to format")
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      getSelection()?.removeAllRanges()
      getSelection()?.addRange(range)
      document.dispatchEvent(new Event("selectionchange"))
      paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
    })
    const formatting = page.getByRole("toolbar", { name: "Document formatting" })
    await expect(formatting).toBeVisible()
    expect(
      await formatting.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.ariaLabel)),
    ).toEqual(["Bold", "Italic", "Underline", "Strikethrough", "Inline code", "Highlight", "Link", "Turn into"])
    const toolbarTokens = await formatting.evaluate((toolbar) => {
      const probe = document.createElement("div")
      probe.style.cssText = [
        "position:fixed",
        "background:var(--surface-raised-stronger-non-alpha)",
        "border:1px solid var(--border-weak-base)",
        "border-radius:var(--radius-md)",
        "font-family:var(--font-family-sans)",
      ].join(";")
      document.body.append(probe)
      const actual = getComputedStyle(toolbar)
      const expected = getComputedStyle(probe)
      const result = {
        actual: [actual.backgroundColor, actual.borderTopColor, actual.borderRadius, actual.fontFamily],
        expected: [expected.backgroundColor, expected.borderTopColor, expected.borderRadius, expected.fontFamily],
      }
      probe.remove()
      return result
    })
    expect(toolbarTokens.actual).toEqual(toolbarTokens.expected)
    await formatting.getByRole("button", { name: "Bold" }).click()

    await rich.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      range.collapse(false)
      getSelection()?.removeAllRanges()
      getSelection()?.addRange(range)
      ;(element as HTMLElement).focus()
    })
    await page.keyboard.press("Enter")
    await page.keyboard.type("/h2")
    const headingCommand = page.locator(".slash-command-item").filter({ hasText: "Heading 2" }).first()
    await expect(headingCommand).toBeVisible()
    await headingCommand.click()
    await page.keyboard.type("Slash heading")

    await expect(page.getByRole("status")).toContainText("Saved", { timeout: 10_000 })
    const saved = runtime.inspect(doc.summary.id).markdown
    expect(saved).toContain("**First paragraph.**")
    expect(saved).toContain("## Slash heading")
    const richHandleAfterSave = await rich.elementHandle()
    if (!richHandleAfterSave) throw new Error("Rich editor disappeared after interaction autosave")
    expect(await page.evaluate(([before, after]) => before === after, [richHandle, richHandleAfterSave])).toBe(true)
    await openDocument(page, doc.summary.id)
    await expect(page.getByRole("textbox", { name: "Document rich editor" })).toContainText("Slash heading")
    expect(pageErrors).toEqual([])
    expect(unexpectedCanaryConsoleErrors(consoleErrors)).toEqual([])
    expect(unexpectedCanaryRequestFailures(requestFailures)).toEqual([])
  })

  test("two tabs surface a CAS conflict and preserve both sides — behavior 5", async ({ page, context }, testInfo) => {
    annotate(testInfo)
    const runtime = new DocumentRuntime()
    const document = runtime.seed({ id: "cas_document", displayName: "CAS", markdown: "Heading\n=======\n\nbase\n" })
    await bootstrap(page, runtime)
    const second = await context.newPage()
    await bootstrap(second, runtime)
    await openDocument(page, document.summary.id)
    await openDocument(second, document.summary.id)
    const staleVersion = runtime.inspect(document.summary.id).version
    const firstSource = await sourceEditor(page)
    const secondSource = await sourceEditor(second)
    await secondSource.fill("Heading\n=======\n\nsecond-tab draft\n")
    await firstSource.fill("Heading\n=======\n\nfirst-tab disk\n")
    // No live-refresh exists any more, so the second tab never learns of the
    // first tab's save until it saves itself — exactly the CAS conflict this
    // behavior asserts.
    await page.keyboard.press("ControlOrMeta+s")
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible()
    const diskAfterFirstSave = runtime.inspect(document.summary.id).markdown
    await second.keyboard.press("ControlOrMeta+s")
    await expect(second.getByRole("heading", { name: "Document changed on disk" })).toBeVisible({ timeout: 10_000 })
    expect(runtime.contentWrites(document.summary.id).at(-1)?.ifMatch).toBe(staleVersion)
    expect(runtime.inspect(document.summary.id).markdown).toBe(diskAfterFirstSave)
    await second.getByText("Compare versions").click()
    await expect(second.getByLabel("Your draft")).toContainText("second-tab draft")
    await expect(second.getByLabel("Current disk version")).toContainText("first-tab disk")
    await proveGeometry(second, second.getByRole("alert"), testInfo, "two-tab-cas-conflict-both-sides")
    await second.close()
  })

  // Live-refresh of an open editor was intentionally removed: an external
  // write no longer follows into an open editor, and a competing write
  // surfaces as a CAS conflict the next time the human saves — never a silent loss.
  // Out-of-contract Markdown still lands in source mode on (re)load, and a previous
  // snapshot stays restorable through the visible history UI.
  test("external write surfaces a CAS conflict on save; out-of-contract edit stays restorable — behavior 6", async ({
    page,
  }, testInfo) => {
    annotate(testInfo, "external file write is injected at the document server boundary")
    const runtime = new DocumentRuntime()
    const document = runtime.seed({
      id: "external_document",
      displayName: "External",
      markdown: "Heading\n=======\n\nbase\n",
    })
    await bootstrap(page, runtime)
    await openDocument(page, document.summary.id)
    let source = await sourceEditor(page)

    // An external write advances the durable version. The open editor does NOT
    // follow it — that is the accepted tradeoff — so it still shows the base bytes.
    runtime.externalEdit(document.summary.id, "Heading\n=======\n\nagent competing edit\n")
    await expect(source).toHaveValue("Heading\n=======\n\nbase\n")
    await proveGeometry(page, source, testInfo, "external-write-does-not-live-refresh")

    // The human edits against the stale base and saves; the stale If-Match is
    // rejected and both sides are preserved in the conflict UI.
    await source.fill("Heading\n=======\n\nhuman dirty draft\n")
    await page.keyboard.press("ControlOrMeta+s")
    await expect(page.getByRole("heading", { name: "Document changed on disk" })).toBeVisible()
    await page.getByText("Compare versions").click()
    await expect(page.getByLabel("Your draft")).toContainText("human dirty draft")
    await expect(page.getByLabel("Current disk version")).toContainText("agent competing edit")
    await proveGeometry(page, page.getByRole("alert"), testInfo, "dirty-cas-conflict-on-save")

    await page.getByRole("button", { name: "Reload disk" }).click()
    source = await sourceEditor(page)
    await expect(source).toHaveValue("Heading\n=======\n\nagent competing edit\n")

    // Out-of-contract Markdown written externally is only seen on reopen (no live
    // refresh); it must open in source mode rather than silently rewrite.
    runtime.externalEdit(document.summary.id, "# Agent MDX\n\n<Component answer={42} />\n")
    await openDocument(page, document.summary.id)
    source = await sourceEditor(page)
    await expect(source).toHaveValue("# Agent MDX\n\n<Component answer={42} />\n")
    await expect(page.getByText("Source mode", { exact: true })).toBeVisible()
    await proveGeometry(page, source, testInfo, "out-of-contract-agent-edit-source-mode")

    await page.getByLabel("More", { exact: true }).click()
    const history = page.getByRole("list", { name: "Document versions" })
    await expect(history).toBeVisible()
    await history.getByRole("button", { name: "Restore" }).first().click()
    await expect(await sourceEditor(page)).toHaveValue("Heading\n=======\n\nagent competing edit\n")
    await proveGeometry(page, await sourceEditor(page), testInfo, "out-of-contract-previous-version-restored")
  })

  test("version restore is CAS-honest and returns exact snapshot bytes — behavior 7", async ({ page }, testInfo) => {
    annotate(testInfo)
    const runtime = new DocumentRuntime()
    const original = "Heading\n=======\n\noriginal snapshot\n"
    const document = runtime.seed({ id: "history_document", displayName: "History", markdown: original })
    await bootstrap(page, runtime)
    await openDocument(page, document.summary.id)
    await saveSource(page, "Heading\n=======\n\nnew current\n")
    const expectedVersion = runtime.inspect(document.summary.id).version
    await page.getByLabel("More", { exact: true }).click()
    const list = page.getByRole("list", { name: "Document versions" })
    await expect(list).toBeVisible()
    await list.getByRole("button", { name: "Restore" }).first().click()
    await expect(await sourceEditor(page)).toHaveValue(original)
    const restore = runtime.requests.find((request) => request.pathname.endsWith("/restore"))
    expect(restore?.ifMatch).toBe(expectedVersion)
    await proveGeometry(page, await sourceEditor(page), testInfo, "version-restore-exact-bytes")
  })

  test("/docs mention resolves an honest path and hydrated file-tool edit persists, seen on reopen — behavior 8 @documents-unsigned-local-canary @documents-release-canary", async ({
    page,
    context,
  }, testInfo) => {
    annotate(
      testInfo,
      "unsigned-local picker access is independent of AI availability; file-tool causality is Tier M and real harness execution remains Tier L session-env evidence",
    )
    const runtime = new DocumentRuntime()
    const document = runtime.seed({
      id: "agent_document",
      displayName: "Agent brief",
      markdown: "Heading\n=======\n\nagent base\n",
    })
    await bootstrap(page, runtime)
    const editorPage = await context.newPage()
    await bootstrap(editorPage, runtime)
    await openDocument(editorPage, document.summary.id)
    const editor = await sourceEditor(editorPage)
    await expect(editor).toHaveValue("Heading\n=======\n\nagent base\n")

    await page.goto(`/w/${PROJECT_ID}/session/${encodeURIComponent(SESSION_ID)}`)
    const composer = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(composer).toBeVisible({ timeout: 30_000 })

    await composer.fill("/docs")
    const slash = page.getByRole("listbox").last()
    await expect(slash).toBeVisible()
    await slash.getByRole("option", { name: /\/docs/ }).click()
    const picker = page.getByRole("listbox", { name: "Documents" })
    await expect(picker).toBeVisible()
    await picker.getByRole("option", { name: /Agent brief/ }).click()
    // The composer inserts the mention as the raw, honest `claxedo://document/<id>`
    // reference (`documentMentionText`, src/app/integrations/document-mentions.ts —
    // pinned by that file's own unit test), not a pre-resolved path string. Resolving
    // it to a canonical hydrated file path is an MCP TOOL's job
    // (`packages/claxedo-mcp/src/documents-tools.ts`'s "Open a claxedo://document/..."
    // tool, which calls `POST /documents/:id/agent-open`) that only runs when a real
    // agent processes the reference during a session turn — Tier L, out of this Tier M
    // mock's reach (see this test's own `annotate()` above). No frontend code path
    // calls `documentsApi.agentOpen` synchronously on mention insertion.
    await expect(composer).toContainText(`claxedo://document/${document.summary.id}`)
    await proveGeometry(page, composer, testInfo, "docs-mention-honest-reference")

    // Simulate what the MCP tool does when a real agent turn later processes this
    // reference: hydrate the canonical file into a session path (mirrors
    // `runtime.hydrateForAgent`'s existing use elsewhere in this file for the same
    // Tier L/Tier M split).
    const hydratedPath = runtime.hydrateForAgent(document.summary.id, SESSION_ID)
    expect(hydratedPath).toBe(`${DIR}/.claxedo/sessions/${SESSION_ID}/docs/${document.summary.id}/agent-brief.md`)
    expect(runtime.hydratedAgentFiles.get(hydratedPath)?.bytes).toBe("Heading\n=======\n\nagent base\n")

    await runtime.runAgentFileTool(hydratedPath, "Heading\n=======\n\nordinary agent file edit\n")
    // The open editor no longer live-refreshes: it still
    // shows the base bytes. The write-back is proven durable by reopening below.
    await expect(editor).toHaveValue("Heading\n=======\n\nagent base\n")
    await proveGeometry(editorPage, editor, testInfo, "agent-file-edit-not-live-refreshed")

    await editorPage.goto(INDEX_URL)
    await openDocument(editorPage, document.summary.id)
    await expect(editorPage).toHaveURL(documentUrl(document.summary.id))
    await expect(await sourceEditor(editorPage)).toHaveValue("Heading\n=======\n\nordinary agent file edit\n")

    await editorPage.getByLabel("More", { exact: true }).click()
    const versions = editorPage.getByRole("list", { name: "Document versions" })
    await expect(versions).toBeVisible()
    await versions.getByRole("button", { name: "Restore" }).first().click()
    await expect(await sourceEditor(editorPage)).toHaveValue("Heading\n=======\n\nagent base\n")
    await proveGeometry(editorPage, await sourceEditor(editorPage), testInfo, "agent-edit-prechange-restored")

    await saveSource(editorPage, "Heading\n=======\n\nhuman continues on same identity\n")
    expect(runtime.inspect(document.summary.id).summary.id).toBe("agent_document")
    expect(runtime.inspect(document.summary.id).markdown).toBe("Heading\n=======\n\nhuman continues on same identity\n")
    await expect(editorPage).toHaveURL(documentUrl(document.summary.id))
    await proveGeometry(editorPage, await sourceEditor(editorPage), testInfo, "human-continues-after-snapshot-restore")
    await editorPage.close()
  })

  test("hosted placement survives hydrated VM loss and reconstructs from durable object bytes — behavior 9", async ({
    page,
  }, testInfo) => {
    annotate(testInfo, "hosted hydration and object placement are locally simulated")
    const runtime = new DocumentRuntime()
    const hosted = runtime.seed({
      id: "hosted_document",
      displayName: "Hosted brief",
      markdown: "Heading\n=======\n\nhosted before VM\n",
      placement: "hosted",
    })
    await bootstrap(page, runtime)
    await openDocument(page, hosted.summary.id)
    const hydratedPath = runtime.hydrateForAgent(hosted.summary.id, SESSION_ID)
    expect(runtime.hostedVmFiles.get(hydratedPath)?.bytes).toBe("Heading\n=======\n\nhosted before VM\n")
    await runtime.runAgentFileTool(hydratedPath, "Heading\n=======\n\nhosted writeback persisted\n")
    const objectKey = hosted.summary.managed_relative_path!
    expect(runtime.hostedObjects.get(objectKey)).toBe("Heading\n=======\n\nhosted writeback persisted\n")
    runtime.disposeHostedVm(hosted.summary.id)
    expect(runtime.hostedVmFiles.has(hydratedPath)).toBe(false)
    expect(runtime.hostedObjects.get(objectKey)).toBe("Heading\n=======\n\nhosted writeback persisted\n")
    expect(runtime.documents.has(hosted.summary.id)).toBe(false)
    await openDocument(page, hosted.summary.id)
    expect(runtime.documents.has(hosted.summary.id)).toBe(true)
    await expect(await sourceEditor(page)).toHaveValue("Heading\n=======\n\nhosted writeback persisted\n")
    await proveGeometry(page, await sourceEditor(page), testInfo, "hosted-reopen-after-emulated-vm-loss")
  })
})
