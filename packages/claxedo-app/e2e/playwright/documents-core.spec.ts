/**
 * SPEC: Documents core — deterministic browser proof
 *
 * PURPOSE — prove the complete Documents user contract in the real Claxedo UI while a
 * deterministic HTTP adapter controls durable index/placement state separately from
 * disposable runtime objects, filesystem versions, snapshots, event delivery, repository
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
 * both draft and disk values. External events replace a clean draft and conflict with a
 * dirty draft. Every accepted write snapshots the previous bytes, and restoration is an
 * explicit history action. Agent access hydrates the canonical file into a session path;
 * an ordinary file-tool write conditionally writes back to the indexed placement. Hosted
 * writes persist in object placement independently of the disposable hydrated VM path.
 *
 * ANATOMY — the index is `main[aria-labelledby=documents-index-title]` with a
 * `ul[aria-label=Documents]`; the editor is `main[aria-label=Document editor]`; rich and
 * source modes expose `Document rich editor` and `Document Markdown source`; persistence
 * is the editor's live `role=status`; conflicts are `role=alert` headed “Document changed
 * on disk” with Reload disk, Save as copy, Overwrite, and Compare versions; history is a
 * “Version history” disclosure containing `ul[aria-label=Document versions]`; `/docs`
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
 *   6. External edits refresh a clean editor live; the same event conflicts with a dirty
 *      editor and preserves both sides. Out-of-contract Markdown lands in source mode and
 *      the previous snapshot is restored through the visible history UI.
 *   7. Version restore is If-Match guarded and replaces the editor with the selected
 *      immutable snapshot.
 *   8. `/docs` resolves one selected document to an honest hydrated path; a causally
 *      subsequent mock file-tool edit conditionally writes back and arrives through the
 *      document event stream. Reopen, snapshot restore, follow-up, and human save retain
 *      the same identity.
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
 * Its event responses are one-shot SSE batches, matching the shared mock's reconnecting
 * stream convention. “agent edit”, “restart”, “checkout loss”, and “VM loss” here validate
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
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-documents-core"
const PROJECT_ID = "proj_documents_core"
const SESSION_ID = "ses_documents_core"
const INDEX_URL = `/w/${encodeURIComponent(DIR)}/page/__index__`

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
  return `/w/${encodeURIComponent(DIR)}/page/${encodeURIComponent(id)}`
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
  private eventWaiters: Array<{ route: Route; documentId?: string; projectId?: string }> = []
  private nextDocument = 1
  private nextSnapshot = 1
  private nextVersion = 1
  private savesFail = false
  private saveLatency = 0
  private suppressedSaveEvents = new Set<string>()

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

  suppressNextSaveEvent(id: string) {
    this.suppressedSaveEvents.add(id)
  }

  inspect(id: string) {
    return this.require(id)
  }

  contentWrites(id?: string) {
    return this.requests.filter(
      (request) => request.method === "PUT" && request.pathname === `/documents/${id ?? ""}/content`,
    )
  }

  async externalEdit(id: string, markdown: string, actor: "agent" | "user" = "agent") {
    const document = this.require(id)
    this.snapshot(document, `before ${actor} edit`, { type: actor, id: `${actor}_documents_core` })
    document.markdown = markdown
    document.version = this.version()
    document.modifiedAt = Date.now()
    document.summary.last_known_file_version = document.version
    document.summary.updated_at = new Date().toISOString()
    this.writePlacement(document)
    this.persistMetadata(document)
    await this.publish(id, actor === "agent" ? "agent.write" : "external.write")
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
    await this.publish(document.summary.id, "agent.write")
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

  private async publish(id: string, reason: string) {
    const document = this.require(id)
    const deadline = Date.now() + 3_000
    while (!this.eventWaiters.some((waiter) => waiter.documentId === id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const matching = this.eventWaiters.filter(
      (waiter) => waiter.documentId === id || (!waiter.documentId && waiter.projectId === document.summary.project_id),
    )
    this.eventWaiters = this.eventWaiters.filter((waiter) => !matching.includes(waiter))
    await Promise.all(
      matching.map(({ route }) =>
        route
          .fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: [
              `data: ${JSON.stringify({ type: "document.connected" })}`,
              `data: ${JSON.stringify({
                type: "document.changed",
                document_id: id,
                project_id: document.summary.project_id,
                reason,
                version: document.version,
                invalidate: ["summary", "content", "snapshots"],
              })}`,
              "",
            ].join("\n\n"),
          })
          .catch(() => undefined),
      ),
    )
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
    if (request.method() === "GET" && parts[1] === "events") {
      this.eventWaiters.push({
        route,
        ...(url.searchParams.get("document_id") ? { documentId: url.searchParams.get("document_id")! } : {}),
        ...(url.searchParams.get("project_id") ? { projectId: url.searchParams.get("project_id")! } : {}),
      })
      return
    }
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
      if (this.suppressedSaveEvents.delete(id)) {
        // The request remains durable while this one event is deliberately lost,
        // forcing a second stale tab to prove CAS at its own Save boundary.
      } else {
        void this.publish(id, "user.save")
      }
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
      void this.publish(id, "snapshot.restore")
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
    workspaceId: DIR,
  })
  await runtime.install(page)
  await page.addInitScript(
    ({ dir }) => {
      localStorage.clear()
      ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
        serverUrl: window.location.origin,
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
    { dir: DIR },
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

async function sourceEditor(page: Page) {
  const source = page.getByLabel("Document Markdown source")
  if (await source.count()) return source
  await page.getByRole("button", { name: "Edit source" }).click()
  await expect(source).toBeVisible()
  return source
}

async function saveSource(page: Page, markdown: string) {
  const source = await sourceEditor(page)
  await source.fill(markdown)
  await page.getByRole("button", { name: "Save now" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible()
  return source
}

function annotate(testInfo: TestInfo, extra = "") {
  testInfo.annotations.push({
    type: "evidence-tier",
    description: `Tier M mock-backed real UI proof${extra ? `; ${extra}` : ""}`,
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
    await page.getByRole("button", { name: "New document" }).click()
    const created = [...runtime.documents.values()][0]!
    await expect(page.getByRole("main", { name: "Document editor" })).toBeVisible()
    const exact = "---\ntitle: Exact bytes\n---\n\n# Managed\n\n- alpha\n- beta\n"
    await saveSource(page, exact)
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
    annotate(testInfo, "repository filesystem is simulated")
    const runtime = new DocumentRuntime()
    runtime.repositoryFiles.set("docs/repository.md", "Heading\n=======\n\nrepository original\n")
    await bootstrap(page, runtime)
    await openIndex(page)
    await page.getByRole("button", { name: "Add to Documents" }).click()
    const dialog = page.getByRole("dialog", { name: "Add repository document" })
    await expect(dialog).toBeVisible()
    await dialog.getByRole("textbox", { name: "Repository Markdown path" }).fill("docs/repository.md")
    await proveGeometry(page, dialog, testInfo, "repository-import-dialog")
    await dialog.getByRole("button", { name: "Add document" }).click()
    await expect(page.getByRole("main", { name: "Document editor" })).toBeVisible()
    const indexed = [...runtime.documents.values()].find(
      (candidate) => candidate.summary.repository_relative_path === "docs/repository.md",
    )!.summary
    const document = runtime.inspect(indexed.id)
    expect(runtime.requests.find((request) => request.pathname === "/documents/from-repo")?.body).toEqual({
      project_id: PROJECT_ID,
      directory: DIR,
      workspace_id: DIR,
      path: "docs/repository.md",
      display_name: "repository.md",
    })
    const contentReadsBeforeIndex = runtime.requests.filter((request) => request.pathname.endsWith("/content")).length
    await openIndex(page)
    await expect(page.getByRole("list", { name: "Documents" })).toContainText("docs/repository.md")
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
    expect(runtime.repositoryFiles.get("docs/repository.md")).toBe(next)
    expect(runtime.managedFiles.has(document.summary.repository_relative_path!)).toBe(false)
    await proveGeometry(page, await sourceEditor(page), testInfo, "repository-edit-in-place")
  })

  test("open-close performs no write and unsupported Markdown falls back to labeled source mode — behavior 3", async ({
    page,
  }, testInfo) => {
    annotate(testInfo)
    const runtime = new DocumentRuntime()
    const supportedBytes = "# Supported\n\nExact rich bytes.\n"
    const supported = runtime.seed({ id: "supported_document", displayName: "Supported", markdown: supportedBytes })
    const unsupported = "# MDX\n\n<Component answer={42} />\n"
    const document = runtime.seed({ id: "unsupported_document", displayName: "MDX", markdown: unsupported })
    await bootstrap(page, runtime)
    await openDocument(page, supported.summary.id)
    await expect(page.getByRole("textbox", { name: "Document rich editor" })).toBeVisible()
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

  test("truthful autosave exposes failure and Retry recovers the preserved draft — behavior 4", async ({
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
    expect(runtime.contentWrites(document.summary.id)).toHaveLength(1)
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

  test("rich editor accepts typing and its autosave event preserves the editor instance — behavior 4", async ({
    page,
  }, testInfo) => {
    annotate(testInfo, "direct rich-editor input and autosave feedback-loop regression")
    const runtime = new DocumentRuntime()
    const document = runtime.seed({ displayName: "Editable rich document", markdown: "# Editable\n\nStart here.\n" })
    await bootstrap(page, runtime)
    await openDocument(page, document.summary.id)
    const rich = page.getByRole("textbox", { name: "Document rich editor" })
    await rich.evaluate((element) => (element.dataset.e2eEditorInstance = "stable"))
    await rich.click()
    await page.keyboard.press("End")
    await page.keyboard.type(" Typed in rich mode.")
    await expect(page.getByRole("status")).toContainText(/Unsaved changes|Saving/)
    await expect(page.getByRole("status")).toContainText("Saved", { timeout: 10_000 })
    await expect(rich).toContainText("Typed in rich mode.")
    await expect(page.getByText("Source mode")).toHaveCount(0)
    expect(await rich.getAttribute("data-e2e-editor-instance")).toBe("stable")
    expect(runtime.inspect(document.summary.id).markdown).toContain("Typed in rich mode.")
    await proveGeometry(page, rich, testInfo, "rich-editor-stable-after-autosave")
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
    runtime.suppressNextSaveEvent(document.summary.id)
    await page.getByRole("button", { name: "Save now" }).click()
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible()
    const diskAfterFirstSave = runtime.inspect(document.summary.id).markdown
    await second.getByRole("button", { name: "Save now" }).click()
    await expect(second.getByRole("heading", { name: "Document changed on disk" })).toBeVisible({ timeout: 10_000 })
    expect(runtime.contentWrites(document.summary.id).at(-1)?.ifMatch).toBe(staleVersion)
    expect(runtime.inspect(document.summary.id).markdown).toBe(diskAfterFirstSave)
    await second.getByText("Compare versions").click()
    await expect(second.getByLabel("Your draft")).toContainText("second-tab draft")
    await expect(second.getByLabel("Current disk version")).toContainText("first-tab disk")
    await proveGeometry(second, second.getByRole("alert"), testInfo, "two-tab-cas-conflict-both-sides")
    await second.close()
  })

  test("clean external refresh then dirty conflict; out-of-contract edit stays restorable — behavior 6", async ({
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
    await runtime.externalEdit(document.summary.id, "Heading\n=======\n\nagent clean refresh\n")
    await expect(source).toHaveValue("Heading\n=======\n\nagent clean refresh\n")
    await proveGeometry(page, source, testInfo, "clean-live-external-refresh")

    await source.fill("Heading\n=======\n\nhuman dirty draft\n")
    await runtime.externalEdit(document.summary.id, "Heading\n=======\n\nagent competing edit\n")
    await expect(page.getByRole("heading", { name: "Document changed on disk" })).toBeVisible()
    await page.getByText("Compare versions").click()
    await expect(page.getByLabel("Your draft")).toContainText("human dirty draft")
    await expect(page.getByLabel("Current disk version")).toContainText("agent competing edit")
    await proveGeometry(page, page.getByRole("alert"), testInfo, "dirty-live-external-conflict")

    await page.getByRole("button", { name: "Reload disk" }).click()
    await runtime.externalEdit(document.summary.id, "# Agent MDX\n\n<Component answer={42} />\n")
    source = await sourceEditor(page)
    await expect(source).toHaveValue("# Agent MDX\n\n<Component answer={42} />\n")
    await expect(page.getByText("Source mode", { exact: true })).toBeVisible()
    await proveGeometry(page, source, testInfo, "out-of-contract-agent-edit-source-mode")

    await page.getByText("Version history", { exact: true }).click()
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
    await page.getByText("Version history", { exact: true }).click()
    const list = page.getByRole("list", { name: "Document versions" })
    await expect(list).toBeVisible()
    await list.getByRole("button", { name: "Restore" }).first().click()
    await expect(await sourceEditor(page)).toHaveValue(original)
    const restore = runtime.requests.find((request) => request.pathname.endsWith("/restore"))
    expect(restore?.ifMatch).toBe(expectedVersion)
    await proveGeometry(page, await sourceEditor(page), testInfo, "version-restore-exact-bytes")
  })

  test("/docs mention resolves an honest path and hydrated file-tool edit refreshes the editor — behavior 8", async ({
    page,
    context,
  }, testInfo) => {
    annotate(testInfo, "mock file-tool causality is Tier M; real harness execution remains Tier L session-env evidence")
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

    await page.goto(`/w/${encodeURIComponent(DIR)}/session`)
    const composer = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await composer.fill("start documents session")
    await page.locator(SELECTORS.submitControl).last().click()
    await expectAssistantReplyVisible(page, "ack 1: start documents session")

    await composer.fill("/docs")
    const slash = page.getByRole("listbox").last()
    await expect(slash).toBeVisible()
    await slash.getByRole("option", { name: /Documents/ }).click()
    const picker = page.getByRole("listbox", { name: "Documents" })
    await expect(picker).toBeVisible()
    await picker.getByRole("option", { name: /Agent brief/ }).click()
    await expect(composer).toContainText(
      `document: Agent brief at ${DIR}/.claxedo/sessions/${SESSION_ID}/docs/${document.summary.id}/agent-brief.md`,
    )
    const agentOpen = runtime.requests.find((request) => request.pathname.endsWith("/agent-open"))
    expect(agentOpen?.body).toEqual({ session_id: SESSION_ID })
    const hydratedPath = `${DIR}/.claxedo/sessions/${SESSION_ID}/docs/${document.summary.id}/agent-brief.md`
    expect(runtime.hydratedAgentFiles.get(hydratedPath)?.bytes).toBe("Heading\n=======\n\nagent base\n")
    await proveGeometry(page, composer, testInfo, "docs-mention-honest-hydrated-path")

    const mentionedPrompt =
      `document: Agent brief at ${DIR}/.claxedo/sessions/${SESSION_ID}/docs/${document.summary.id}/agent-brief.md ` +
      `(document_id: ${document.summary.id})`
    await page.locator(SELECTORS.submitControl).last().click()
    await expectAssistantReplyVisible(page, `ack 2: ${mentionedPrompt}`)

    await runtime.runAgentFileTool(hydratedPath, "Heading\n=======\n\nordinary agent file edit\n")
    await expect(editor).toHaveValue("Heading\n=======\n\nordinary agent file edit\n")
    await proveGeometry(editorPage, editor, testInfo, "agent-file-edit-live-refresh")

    await editorPage.goto(INDEX_URL)
    await openDocument(editorPage, document.summary.id)
    await expect(editorPage).toHaveURL(documentUrl(document.summary.id))
    await expect(await sourceEditor(editorPage)).toHaveValue("Heading\n=======\n\nordinary agent file edit\n")

    await editorPage.getByText("Version history", { exact: true }).click()
    const versions = editorPage.getByRole("list", { name: "Document versions" })
    await expect(versions).toBeVisible()
    await versions.getByRole("button", { name: "Restore" }).first().click()
    await expect(await sourceEditor(editorPage)).toHaveValue("Heading\n=======\n\nagent base\n")
    await proveGeometry(editorPage, await sourceEditor(editorPage), testInfo, "agent-edit-prechange-restored")

    await composer.fill("Follow up in the normal session")
    await page.locator(SELECTORS.submitControl).last().click()
    await expectAssistantReplyVisible(page, "ack 3: Follow up in the normal session")
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
