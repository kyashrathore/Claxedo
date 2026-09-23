/** Real relay, host tunnel, browser, and runtime with a scripted model endpoint.
 * These Tier R checks cover browser transport, host-started streaming, PTY output,
 * role denial, and offline recovery. They do not exercise a hosted deployment.
 */
import { expect, test, type Page, type Request } from "@playwright/test"
import path from "node:path"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"
import { startScriptedModelServer, type ScriptedModelServer } from "../helpers/scripted-model-server"
import {
  APP_DIR,
  buildAndServeWebApp,
  gateReachesReady,
  seedWorkspace,
  sessionRoute,
  startSignedRelayFixture,
  type RelayFixtureInfo,
  type RunningRelayFixture,
  type RunningWebApp,
} from "../helpers/web-signed-relay-harness"
import { watchForbiddenDirectRequests } from "../helpers/web-signed-relay-journeys"
// The one owner of the app's message-id scheme. A host-side turn has to mint
// its user-message id with it: OpenCode's own turn loop exits on
// `lastUser.id < lastAssistant.id` (`packages/opencode/src/session/prompt.ts`),
// so an id that does not sort before the engine's generated reply id never
// satisfies that comparison and the engine re-prompts the model forever.
import { Identifier } from "../../src/lib/id"

const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const BACKEND_PORT = Number(process.env.CLAXEDO_REAL_HOST_TUNNEL_RELAY_BACKEND_PORT ?? 4567)
const PREVIEW_PORT = Number(process.env.CLAXEDO_REAL_HOST_TUNNEL_RELAY_PREVIEW_PORT ?? 4569)
const OUT_DIR = path.join(APP_DIR, "dist-e2e-real-host-tunnel-relay")

let scripted: ScriptedModelServer
let fixture: RunningRelayFixture
let webApp: RunningWebApp

/** Fixture-only routes on the backend, reached from this process — never from the page. */
async function fixturePost(pathname: string) {
  const res = await fetch(`${fixture.info.backendUrl}${pathname}`, { method: "POST" })
  if (!res.ok) throw new Error(`GATING: POST ${pathname} failed: ${res.status} ${await res.text()}`)
}
const pauseTunnel = () => fixturePost("/__fixture/tunnel/pause")
const resumeTunnel = () => fixturePost("/__fixture/tunnel/resume")
async function mintRole(role: "viewer" | "editor" | "owner" | "admin") {
  const res = await fetch(`${fixture.info.backendUrl}/__fixture/mint?role=${role}`)
  if (!res.ok) throw new Error(`GATING: /__fixture/mint?role=${role} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as { runtimeAccessToken: string; relayUrl: string }
}

const SCRIPTED_MODEL = { providerID: "pi", modelID: "openai/gpt-4" } as const

/**
 * Creates a session host-side through the real two-halves private-session protocol:
 * the authenticated reservation on the control plane
 * (`POST /api/control/session-registrations/reserve`) and the RHT-authenticated
 * creation on the workspace runtime, carrying the reservation in
 * `x-claxedo-session-registration-operation`. A managed-private runtime refuses
 * either half alone (`session_reservation_required`), so this is the only way such a
 * session comes to exist — and it makes the browser's later navigation an attach to
 * a session it did not create.
 */
async function createHostSession(fixture: RunningRelayFixture, title: string) {
  const sessionId = Identifier.ascending("session")
  const operationId = `op_live_${Date.now().toString(36)}`
  const reserved = await fetch(`${fixture.info.backendUrl}/api/control/session-registrations/reserve`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixture.info.controlPlaneToken}`, "content-type": "application/json" },
    body: JSON.stringify({ operationId, sessionId, workspaceId: fixture.info.workspaceId, kind: "create", title }),
  })
  if (!reserved.ok) throw new Error(`GATING: session reservation failed: ${reserved.status} ${await reserved.text()}`)
  const created = await fetch(
    `${fixture.info.relayUrl}/workspaces/${encodeURIComponent(fixture.info.workspaceId)}/session?nativeHarness=pi`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.info.runtimeAccessToken}`,
        "content-type": "application/json",
        "x-claxedo-session-registration-operation": operationId,
      },
      body: JSON.stringify({ id: sessionId, title }),
    },
  )
  if (!created.ok) throw new Error(`GATING: host session create failed: ${created.status} ${await created.text()}`)
  return sessionId
}

/**
 * Starts a turn host-side — the fixture's own runtime, reached over the real relay
 * with the fixture's own Runtime Access Token — never through the browser's
 * composer, so the page is a viewer of a turn nobody in it started.
 */
async function startHostTurn(fixture: RunningRelayFixture, input: { sessionId: string; marker: string }) {
  const messageID = Identifier.ascending("message")
  const res = await fetch(
    `${fixture.info.relayUrl}/workspaces/${encodeURIComponent(fixture.info.workspaceId)}/session/${encodeURIComponent(input.sessionId)}/prompt_async`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${fixture.info.runtimeAccessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        messageID,
        model: SCRIPTED_MODEL,
        parts: [{
          type: "text",
          text: `Reply with exactly this one token and nothing else, no punctuation, no formatting: ${input.marker}`,
        }],
      }),
    },
  )
  if (!res.ok) throw new Error(`GATING: host prompt_async failed: ${res.status} ${await res.text()}`)
  return { messageID, at: Date.now() }
}

/**
 * Mints a connection through the product endpoint from inside the page, never an
 * out-of-band token, and returns the fields the client's own `relayFetch` would use, so
 * the transport assertions ride the same authorization the app relies on.
 */
async function mintConnectionFromPage(page: Page, info: RelayFixtureInfo) {
  // The fixture-minted JWT, never a literal: the control plane is the real
  // `customVerifierAuthAdapter`, which 401s anything it cannot verify.
  return await page.evaluate(async (input: { workspaceId: string; token: string }) => {
    const res = await fetch(`/api/workspace/${encodeURIComponent(input.workspaceId)}/connection`, {
      headers: { authorization: `Bearer ${input.token}` },
    })
    if (!res.ok) throw new Error(`connection mint failed: ${res.status} ${await res.text()}`)
    return (await res.json()) as { relayUrl: string; runtimeAccessToken: string; role: string }
  }, { workspaceId: info.workspaceId, token: info.controlPlaneToken })
}

async function relayFetchFromPage(
  page: Page,
  input: { relayUrl: string; workspaceId: string; token: string; path: string; method?: string; body?: unknown },
) {
  return await page.evaluate(async (i) => {
    const res = await fetch(`${i.relayUrl}/workspaces/${encodeURIComponent(i.workspaceId)}${i.path}`, {
      method: i.method ?? "GET",
      headers: {
        authorization: `Bearer ${i.token}`,
        ...(i.body ? { "content-type": "application/json" } : {}),
      },
      ...(i.body ? { body: JSON.stringify(i.body) } : {}),
    })
    const text = await res.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: res.status, ok: res.ok, json, text }
  }, input)
}

// Not `.serial`: each test brings its own page, navigation and connect, and `.serial`
// would skip every later test after one failure. Only the `beforeAll`-booted fixture and
// frontend are shared; ordering is not.
test.describe("real host tunnel relay @core @tier-real", () => {
  test.skip(
    !TIER_REAL,
    "Tier R: set CLAXEDO_TIER_REAL_E2E=1 to run the real local relay and host tunnel with the scripted model endpoint. Requires bun and node on PATH.",
  )

  let forbiddenHits: string[] = []

  test.beforeAll(async () => {
    if (!TIER_REAL) return
    test.setTimeout(180_000)
    scripted = await startScriptedModelServer()
    fixture = await startSignedRelayFixture({
      backing: "local-worktree",
      backendPort: BACKEND_PORT,
      browserUrl: `http://app.localhost:${PREVIEW_PORT}`,
      scripted,
      claudeConfigDir: path.join(APP_DIR, "..", "..", "node_modules", ".cache", "real-host-tunnel-relay-claude"),
    })
    webApp = await buildAndServeWebApp({
      backendUrl: fixture.info.backendUrl,
      relayUrl: fixture.info.relayUrl,
      outDir: OUT_DIR,
      previewPort: PREVIEW_PORT,
    })
  })

  test.afterAll(async () => {
    if (!TIER_REAL) return
    // Across the whole run nothing hit a bare path at the backend origin.
    try {
      expect(forbiddenHits, `forbidden direct-path requests observed: ${JSON.stringify(forbiddenHits)}`).toEqual([])
    } finally {
      await Promise.allSettled([webApp?.close(), fixture?.close(), scripted?.close()])
    }
  })

  test.beforeEach(async ({ page }) => {
    if (!TIER_REAL) return
    watchForbiddenDirectRequests(page, new URL(fixture.info.backendUrl).origin, forbiddenHits)
  })

  // A client-side Playwright error cannot show why the fixture refused something, so
  // its log tail is surfaced on any non-green result.
  test.afterEach(async () => {
    const testInfo = test.info()
    if (!TIER_REAL || testInfo.status === testInfo.expectedStatus) return
    console.log(
      `\n[real-host-tunnel-relay] fixture log tail after "${testInfo.title}" (${testInfo.status}):\n${fixture?.log().slice(-4000)}`,
    )
  })

  test("the real register+tunnel-up sequence makes the workspace appear ready", async ({ page }) => {
    test.setTimeout(60_000)
    await seedWorkspace(page, fixture.info, "local-worktree")
    await page.goto(`${webApp.url}${sessionRoute(fixture.info)}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await gateReachesReady(page)
  })

  test("health, file read, and PTY create/list/delete complete through the real relay lane", async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await seedWorkspace(page, fixture.info, "local-worktree")
    await page.goto(`${webApp.url}${sessionRoute(fixture.info)}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
    await gateReachesReady(page)

    const connection = await mintConnectionFromPage(page, fixture.info)
    // The real mint derives the role from the caller's own authority role on the
    // workspace (`connections/host-tunnel-connection.ts`'s `relayRole(result.role)`),
    // not from any fixture setting: `browserSubject` is the identity that registered
    // this workspace, so the authority answers "owner" and the token carries it.
    expect(connection.role).toBe("owner")

    const health = await relayFetchFromPage(page, {
      relayUrl: connection.relayUrl,
      workspaceId: fixture.info.workspaceId,
      token: connection.runtimeAccessToken,
      path: "/api/wr/health",
    })
    expect(health.ok, JSON.stringify(health)).toBe(true)

    const file = await relayFetchFromPage(page, {
      relayUrl: connection.relayUrl,
      workspaceId: fixture.info.workspaceId,
      token: connection.runtimeAccessToken,
      path: "/file/content?path=hello.txt",
    })
    expect(file.ok, JSON.stringify(file)).toBe(true)
    expect((file.json as { content?: string })?.content ?? "").toContain("hello through signed browser relay")

    const created = await relayFetchFromPage(page, {
      relayUrl: connection.relayUrl,
      workspaceId: fixture.info.workspaceId,
      token: connection.runtimeAccessToken,
      path: "/api/wr/pty",
      method: "POST",
      // A managed workspace runtime scopes every terminal to a session it can
      // authorize the caller against (`workspace-runtime/src/routes/pty.ts` ->
      // `session-access-policy`); an unscoped create is refused 400
      // `pty_session_id_required`, and `GET /api/wr/pty` only lists rows whose
      // session the caller may read.
      body: { cwd: ".", sessionId: fixture.info.sessionId },
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const directPtyId = (created.json as { id?: string })?.id
    expect(directPtyId).toBeTruthy()

    const listedBeforeDelete = await relayFetchFromPage(page, {
      relayUrl: connection.relayUrl,
      workspaceId: fixture.info.workspaceId,
      token: connection.runtimeAccessToken,
      path: "/api/wr/pty",
    })
    expect(listedBeforeDelete.ok, JSON.stringify(listedBeforeDelete)).toBe(true)
    expect((listedBeforeDelete.json as Array<{ id: string }>).map((p) => p.id)).toContain(directPtyId)

    const deleted = await relayFetchFromPage(page, {
      relayUrl: connection.relayUrl,
      workspaceId: fixture.info.workspaceId,
      token: connection.runtimeAccessToken,
      path: `/api/wr/pty/${directPtyId}`,
      method: "DELETE",
    })
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true)

    const listedAfterDelete = await relayFetchFromPage(page, {
      relayUrl: connection.relayUrl,
      workspaceId: fixture.info.workspaceId,
      token: connection.runtimeAccessToken,
      path: "/api/wr/pty",
    })
    expect(listedAfterDelete.ok, JSON.stringify(listedAfterDelete)).toBe(true)
    expect((listedAfterDelete.json as Array<{ id: string }>).map((p) => p.id)).not.toContain(directPtyId)
  })

  // The product surface on top of the PTY transport: the toolbar's New Terminal
  // control, the rail row, the mounted xterm, and the shell's bytes arriving back
  // over the tunnel.
  //
  // xterm paints to a canvas, so the output is read through the accessibility
  // layer xterm mounts when `screenReaderMode` is on, a persisted product
  // preference (`claxedo.terminal.screen-reader-mode`,
  // `platform/settings/terminal-preferences.ts`).
  test("a terminal opened from the browser runs on the host and streams its output back", async ({ page }) => {
    test.setTimeout(120_000)
    await seedWorkspace(page, fixture.info, "local-worktree")
    // `createTerminalInstance` seeds each new xterm from this preference at
    // construction, so it has to be persisted before the terminal is created.
    await page.addInitScript(() => {
      localStorage.setItem("claxedo.terminal.screen-reader-mode", "1")
    })
    // A session route, not the bare draft: a managed workspace runtime scopes every
    // terminal to a session it can authorize the caller against
    // (`workspace-runtime/src/routes/pty.ts` -> `pty_session_id_required`).
    await page.goto(`${webApp.url}${sessionRoute(fixture.info, fixture.info.sessionId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
    await expect(page.locator(`[data-testid="session-content"][data-session-id="${fixture.info.sessionId}"]`))
      .toBeVisible({ timeout: 60_000 })

    // The one New Terminal control (`workspace-toolbar.tsx`), then the creator's
    // plain-shell tile.
    await page.locator('[data-testid="workspace-scope-new-terminal"]').click()
    const launchers = page.locator('[data-component="terminal-new-launchers"]')
    await expect(launchers).toBeVisible({ timeout: 20_000 })
    await launchers.locator('[data-slot="terminal-launcher"][data-launcher-id="shell"]').click()

    // The pane the app mounted, and the id it mounted under: a `pty_`-prefixed id
    // minted by the host's PTY subsystem over the relay, not a client placeholder.
    const pane = page.locator('[data-testid="terminal-pane"][data-terminal-id^="pty_"]')
    await expect(pane).toBeVisible({ timeout: 45_000 })
    const ptyId = await pane.getAttribute("data-terminal-id")
    expect(ptyId, "the mounted terminal pane carries no PTY id").toBeTruthy()
    await expect(page.locator(`[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${ptyId}"]`))
      .toBeVisible({ timeout: 30_000 })

    // The host really has this PTY, asked over the relay through the app's own
    // connection mint.
    const connection = await mintConnectionFromPage(page, fixture.info)
    const listed = await relayFetchFromPage(page, {
      relayUrl: connection.relayUrl,
      workspaceId: fixture.info.workspaceId,
      token: connection.runtimeAccessToken,
      path: "/api/wr/pty",
    })
    expect(listed.ok, JSON.stringify(listed)).toBe(true)
    expect(
      (listed.json as Array<{ id: string }>).map((pty) => pty.id),
      "the PTY the browser opened is not on the host's own list",
    ).toContain(ptyId)

    // …and its output reaches the browser. The marker is unique to this run, so a
    // stale buffer or a prompt painted before the tunnel opened cannot pass.
    const marker = `TTY-${`${Date.now()}`.slice(-6)}`
    const readout = () =>
      page.evaluate((id) => {
        const host = document.querySelector(`[data-testid="terminal-pane"][data-terminal-id="${id}"]`)
        return (host?.textContent ?? "")
      }, ptyId!)
    await pane.click()
    await page.keyboard.type(`printf 'TTY-%s\\n' '${marker.slice(4)}'`)
    await page.keyboard.press("Enter")
    await expect
      .poll(readout, {
        timeout: 45_000,
        message: "the shell's echo never reached the browser through the relay",
      })
      .toContain(marker)
  })


  // Attach from the web client to a session running on another machine's workspace and
  // receive its stream as it happens. The browser is a pure viewer: the session is
  // created host-side before it navigates, and the turn starts host-side after it
  // has attached.
  //
  // The oracle for "live" is growth, not arrival: the scripted endpoint streams the
  // reply as paced deltas, so a client rendering as it happens shows at least two
  // strictly increasing partial lengths before the final text. A client that only
  // learns the reply from the settle-triggered `GET /session/:id/message` refetch
  // jumps from nothing to the whole message, so the request tap also proves no such
  // refetch landed during the growth.
  //
  // The workspace stream carries both halves of the turn: the opencode publisher
  // (`agent-sdk-runtime/src/harnesses/opencode/events.ts`) stamps every frame with
  // the turn's stable reply id and carries the prompt as `user-message-delta`, and
  // the compat projection (`opencode-compat/projection.ts`) opens the prompt row and
  // parents the reply row on it (`userMessageIdForAssistantReply`), so the timeline
  // has both rows before the first delta lands. The host tunnel strips the remote
  // caller's `Origin`/`Host` and forwarded-client headers before replaying onto its
  // loopback server (`loopbackReplayHeaders`); without that every relay call 401s
  // `workspace_relay_local_loopback_required`.
  test("an attached pane renders a host-started turn as it streams", async ({ page }) => {
    test.setTimeout(180_000)
    scripted.resetCounts()
    // Six deltas 700ms apart: long enough that a viewer rendering live has
    // several observable intermediate states, short enough that the whole turn
    // finishes well inside the oracle's own budget.
    scripted.setTextStreamPacing({ chunks: 6, delayMs: 700 })

    const marker = `LIVEHOST-${`${Date.now()}`.slice(-6)}-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF`
    const sessionId = await createHostSession(fixture, "attached host session")

    // Every relay request the page makes, with start and finish times, to answer
    // two questions: did the workspace stream open before the turn started, and
    // did any whole-transcript refetch land while the text was growing.
    type Tap = { url: string; startedAt: number; finishedAt?: number }
    const relayCalls: Tap[] = []
    const taps = new WeakMap<Request, Tap>()
    const relayOrigin = new URL(fixture.info.relayUrl).origin
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.origin !== relayOrigin) return
      const tap: Tap = { url: `${request.method()} ${url.pathname}${url.search}`, startedAt: Date.now() }
      relayCalls.push(tap)
      taps.set(request, tap)
    })
    const settle = (request: Request) => {
      const tap = taps.get(request)
      if (tap) tap.finishedAt = Date.now()
    }
    page.on("requestfinished", settle)
    page.on("requestfailed", settle)

    await seedWorkspace(page, fixture.info, "local-worktree")
    await page.goto(`${webApp.url}${sessionRoute(fixture.info, sessionId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
    await expect(page.locator(`[data-testid="session-content"][data-session-id="${sessionId}"]`))
      .toBeVisible({ timeout: 60_000 })

    // The stream has to be listening before the turn's frames exist — a stream
    // that opens afterwards turns a live turn into a late burst. The owner's own
    // host serves it workspace-wide, so it opens with no session scope.
    await expect
      .poll(() => relayCalls.filter((call) => call.url.includes("/api/wr/events") && !call.url.includes("sessionID=")).length, {
        timeout: 60_000,
        message:
          "the app never opened the workspace stream for the attached session — " +
          `relay calls seen: ${JSON.stringify(relayCalls.map((call) => call.url))}`,
      })
      .toBeGreaterThan(0)

    const turn = await startHostTurn(fixture, { sessionId, marker })

    // Samples what is on screen while the host streams, by length: the assertion is
    // that the rendered reply grew, which a whole-message settle cannot produce.
    //
    // The DOM is read directly rather than through a Locator, whose accessors
    // auto-wait for their element: the first read would block until an assistant row
    // exists, by which time the turn can be over and every intermediate state gone.
    // A sampler that cannot observe "not yet" cannot observe growth.
    //
    // `assistantContent` includes `aria-hidden` rows: the timeline marks the active
    // turn's assistant content `aria-hidden` while it is working (`workingTurn`,
    // `message-timeline.tsx`), and that content is fully on screen. The settled oracle
    // below still uses the visible selector.
    const samples: Array<{ at: number; text: string }> = []
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const text = await page.evaluate(
        (selector) => [...document.querySelectorAll(selector)].map((node) => (node as HTMLElement).innerText ?? "").join(""),
        SELECTORS.assistantContent,
      ).catch(() => "")
      samples.push({ at: Date.now(), text })
      if (text.includes(marker)) break
      await page.waitForTimeout(100)
    }

    // "+ms since the turn started -> characters rendered", deduped: the whole
    // diagnostic a failure needs, in one line.
    const growth = samples
      .map((sample) => ({ at: sample.at - turn.at, length: sample.text.length }))
      .filter((sample, index, all) => index === 0 || sample.length !== all[index - 1].length)
      .map((sample) => `+${sample.at}ms:${sample.length}`)
    const final = samples.at(-1)
    expect(
      final?.text ?? "",
      `the attached pane never rendered the host's reply. Rendered lengths over time: ${JSON.stringify(growth)}. ` +
        `Relay calls the page made: ${JSON.stringify(relayCalls.map((call) => call.url))}`,
    ).toContain(marker)

    // The address the pane registered, and the addresses the lanes published
    // under: a mismatch here is the whole failure, so name both in the message.
    const paneScopes = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="session-content"]')]
        .map((node) => `${node.getAttribute("data-session-id")}@${node.getAttribute("data-session-directory")}`))
    const partials = samples
      .filter((sample) => sample.text.length > 0 && !sample.text.includes(marker))
      .map((sample) => sample.text.length)
    const distinctPartials = [...new Set(partials)]
    expect(
      distinctPartials.length,
      "the reply appeared as one finished block instead of growing — the pane is being fed by a whole-turn " +
        `refetch, not by the host's live stream. Rendered lengths over time: ${JSON.stringify(growth)}. ` +
        `Panes: ${JSON.stringify(paneScopes)}. Relay calls: ${JSON.stringify(relayCalls.map((call) => `+${call.startedAt - turn.at}ms ${call.url}`))}`,
    ).toBeGreaterThanOrEqual(2)
    expect(
      Math.max(...distinctPartials),
      `an intermediate render was not shorter than the final text (${JSON.stringify(growth)})`,
    ).toBeLessThan(final!.text.length)

    // …and no whole-transcript refetch delivered any of it: none finished while the
    // text was growing. The window runs from the first partial render to the last,
    // the only span in which a refetch could have produced a partial. The app hydrates
    // the session on navigation (`view=latest-surface` + `view=latest-turn`) and one of
    // those races the host's prompt, but a fetch that settled before a single character
    // was on screen delivered none of them.
    const partialSamples = samples.filter((sample) => sample.text.length > 0 && !sample.text.includes(marker))
    const firstPartialAt = partialSamples[0].at
    const lastPartialAt = partialSamples.at(-1)!.at
    const refetches = relayCalls.filter((call) =>
      call.url.startsWith("GET ") && call.url.includes(`/session/${encodeURIComponent(sessionId)}/message`))
    expect(
      refetches.filter((call) => (call.finishedAt ?? call.startedAt) >= firstPartialAt && (call.finishedAt ?? call.startedAt) <= lastPartialAt),
      `a whole-turn message refetch landed while the text was growing, so the growth is not proof of the live ` +
        `lane: ${JSON.stringify(refetches)}`,
    ).toEqual([])

    // The full three-layer oracle on the settled turn, and the model endpoint's
    // own receipt that the turn really crossed the relay into the engine.
    await expectAssistantReplyVisible(page, new RegExp(marker), {
      spec: "real-host-tunnel-relay",
      scenario: "attached-host-turn",
      timeout: 60_000,
    })
    expect(
      scripted.counts().responses,
      `the scripted model endpoint was never reached, so no real turn ran: ${JSON.stringify(scripted.counts())}`,
    ).toBeGreaterThan(0)
  })

  test("viewer-role tokens are real-denied writes and PTY, but allowed reads", async ({ page }) => {
    test.setTimeout(60_000)
    await seedWorkspace(page, fixture.info, "local-worktree")
    await page.goto(`${webApp.url}${sessionRoute(fixture.info)}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
    await gateReachesReady(page)

    const viewer = await mintRole("viewer")
    // The page reaches the relay the way the product does, through the gateway origin
    // it was served from (`/workspaces/*` is proxied to the relay), never the relay's
    // own loopback origin, which the browser cannot address cross-origin. The viewer
    // token is what is under test.
    const relayUrl = webApp.url

    const health = await relayFetchFromPage(page, {
      relayUrl,
      workspaceId: fixture.info.workspaceId,
      token: viewer.runtimeAccessToken,
      path: "/api/wr/health",
    })
    expect(health.ok, JSON.stringify(health)).toBe(true)

    const fileRead = await relayFetchFromPage(page, {
      relayUrl,
      workspaceId: fixture.info.workspaceId,
      token: viewer.runtimeAccessToken,
      path: "/file/content?path=hello.txt",
    })
    expect(fileRead.ok, JSON.stringify(fileRead)).toBe(true)

    const writeAttempt = await relayFetchFromPage(page, {
      relayUrl,
      workspaceId: fixture.info.workspaceId,
      token: viewer.runtimeAccessToken,
      path: "/session",
      method: "POST",
      body: {},
    })
    expect(writeAttempt.status).toBe(403)
    expect((writeAttempt.json as { error?: { code?: string } })?.error?.code).toBe("relay_role_denied")

    const ptyList = await relayFetchFromPage(page, {
      relayUrl,
      workspaceId: fixture.info.workspaceId,
      token: viewer.runtimeAccessToken,
      path: "/api/wr/pty",
    })
    expect(ptyList.status).toBe(403)
    expect((ptyList.json as { error?: { code?: string } })?.error?.code).toBe("relay_role_denied")


  })

  // The real host-tunnel lifecycle, proven through the gate the product mounts for
  // a relay-backed workspace. What makes the gate reachable at all is the app
  // classifying this workspace as machine-placed, and that classification reads the
  // project inventory (`src/platform/runtime/session-workspace.ts` through
  // `signedWorkspaceFromProjects` / `localWorkspaceInProjects`). The inventory the
  // app resolves depends on the transport it picks for its control plane: a
  // loopback-literal base makes `centralTransportForServer` answer `loopback`, the
  // app reads the DAEMON's own `/project` catalog, and `mergeWorkspaceCatalog`
  // deliberately lets that direct row (kind `local`, the host's path) win over the
  // control plane's machine-placed echo of the same workspace — correct for the
  // desktop, wrong for the web client this spec drives. Addressing the fixture's
  // control plane by a front-door hostname (see `buildAndServeWebApp`) is what puts the
  // app on the signed-web path it is here to prove, and the gate then mounts.
  test(
    "pausing the real host tunnel surfaces the offline view on reload, and resuming lets Retry reconnect without another reload",
    async ({ page }) => {
      test.setTimeout(90_000)
      await seedWorkspace(page, fixture.info, "local-worktree")
      await page.goto(`${webApp.url}${sessionRoute(fixture.info)}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
      await gateReachesReady(page)

      await pauseTunnel()
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 })

      // The offline view, not a stuck connecting spinner or a Local/Cloud draft
      // picker.
      const offline = page.locator('[data-testid="workspace-offline"]')
      await expect(offline).toBeVisible({ timeout: 45_000 })
      await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0)

      await resumeTunnel()

      // Retry reconnects with no further reload.
      const retry = page.locator('[data-testid="workspace-offline-retry"]')
      await expect(retry).toBeVisible({ timeout: 20_000 })
      await retry.click()

      await expect(offline).toHaveCount(0, { timeout: 45_000 })
      await gateReachesReady(page)
    } finally {
      await resumeTunnel()
    }
    },
  )
})

