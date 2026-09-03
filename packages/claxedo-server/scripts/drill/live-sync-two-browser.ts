/**
 * `live-sync-two-browser` — the W7.3 / W5.4 vision-verified two-browser
 * live-sync drill on the CF composition.
 *
 * WHY THIS EXISTS: finding B3 of `docs/cf-reliability-scalability-review-2026-07-28.md`
 * is marked FIXED on the strength of unit tests alone, and the review says so
 * itself: *"recovered without user interaction" is asserted in tests, not yet
 * proven against a real pair of browsers.* Per the repo's standing rule that
 * green tests are claims rather than proof, this harness is the proof. Two real
 * Chromium browsers subscribe to one org's stream; one publishes; the other must
 * update with ZERO interaction.
 *
 * ## What is real here
 *
 * - **workerd via miniflare**, the runtime the Worker deploys to, serving on a
 *   real TCP port. Two real browsers connect over real HTTP.
 * - **The real `LiveSyncRoom` Durable Object** — `state.acceptWebSocket`,
 *   hibernation, the internal-WebSocket-to-SSE bridge, the retention ring, the
 *   `id:`-line contract, and `replayGapEvent` are all production code.
 * - **The real hosted events route** — `HostedShellRoutes` from
 *   `routes/hosted/shell.ts`, mounted on a real Hono app at the real
 *   `/api/wr/events` path. This matters: the route, not the DO, is what resolves
 *   the authority-internal org id at connect and hands it to the room, which is
 *   exactly the namespace half of B3 (problem 1). Tests that call
 *   `connectLiveSyncRoom` directly skip it.
 * - **The real publishers' room derivation** — `liveSyncRoomNameForPrincipal`,
 *   the single derivation `hosted-core-app.ts` uses for the owner-scoped
 *   `sessionShareChangedSink` nudge. (No hosted Worker composition mounts a
 *   documents sink today — see `documents/backend.ts`'s doorbell-sink note.)
 * - **The real client contract** — the viewer page replicates
 *   `claxedo-app/src/app/integrations/claxedo-events.tsx`'s fetch + manual
 *   reader loop and its `Last-Event-ID` handling line for line.
 *
 * ## What is NOT real, and why
 *
 * - **the retired hosted identity and storage stack are replaced by an injected verifier + `resolveOrgId`.**
 *   This is not laziness, it is the only available seam: `createHostedCoreApp`
 *   refuses to boot without both, in three independent fail-closed gates
 *   (`hosted-core-app.ts:129-158` `assertHostedCoreBootConfig`,
 *   `hosted-services.ts:364-374` `composeHostedControlPlane`, and
 *   `deployment-mode.ts:236-247` `unsignedLocalRequestGuard`, which 503s every
 *   request when hosted mode sees auth disabled). No env var relaxes any of
 *   them. `HostedShellRouteOptions` exposes `verifier` and `resolveOrgId` as
 *   injection points (`routes/hosted/shell.ts`) and `customVerifierAuthAdapter`
 *   exists for exactly this (`authority/auth.ts:179`), so the drill mounts
 *   the genuine route with a synthetic identity provider. The bearer token IS
 *   the subject, matching `hosted-core-app.test.ts`'s `plane()` fixture verifier.
 * - **The app-shell rendering layer is not in the loop.** The viewer renders
 *   received frames into the DOM; it is not `claxedo-app`. Standing up the real
 *   app additionally requires a hosted documents backend
 *   store to have anything to publish FROM, plus pinned-port CORS and a
 *   dedicated vite — at which point most of "the CF composition" would be
 *   doubles. The gap this leaves is stated explicitly in the report: what
 *   `document-index.tsx:365` and `sync-lifecycle.ts:134` do with a delivered
 *   nudge is covered by app-level tests, not by this drill.
 *
 * ## Scenarios
 *
 * 1. **live** — B publishes nothing, A publishes; B receives with no interaction.
 * 2. **reconnect-replay** — B's stream is dropped at the TCP level, a nudge is
 *    published while it is down, B reconnects with its `Last-Event-ID` and the
 *    missed frame is replayed.
 * 3. **replay-gap** — B is dropped, the ring is overrun (>256 frames), B
 *    reconnects and gets the explicit `stream.replay-gap` notice instead of a
 *    hole-ridden partial log.
 * 4. **visibility** — `session.share.changed` is subject-scoped: A's nudge must
 *    reach A and NOT B, though both are held in the same org room.
 * 5. **positive control** — the publisher rings a WRONG room name. B must
 *    receive nothing. This is what proves scenarios 1-3 have teeth.
 *
 * Usage:
 *   node --import tsx scripts/drill/live-sync-two-browser.ts
 *   node --import tsx scripts/drill/live-sync-two-browser.ts --headed
 */

import { createRequire } from "node:module"
import { mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises"
import { createServer } from "node:http"
import { build } from "esbuild"
import { Miniflare } from "miniflare"

// playwright-core is installed for `claxedo-app`, not this package, and adding a
// dependency here would put a browser driver in the server package's tree for
// the sake of one drill. Resolve it from the package that legitimately owns it.
const appRequire = createRequire(new URL("../../../claxedo-app/package.json", import.meta.url))
// playwright-core has no type declarations visible from this package (it is a
// claxedo-app dependency); the drill treats it as a minimally-typed surface.
const { chromium } = appRequire("playwright-core") as {
  chromium: {
    launch(options?: { headless?: boolean }): Promise<{
      newContext(options?: Record<string, unknown>): Promise<any>
      close(): Promise<void>
    }>
  }
}

const HEADED = process.argv.includes("--headed")
const OUT_DIR = new URL("../../.artifacts/drill/live-sync-two-browser/", import.meta.url).pathname

/** The authority-internal org id both browsers resolve to. */
const ORG = "org_internal_acme"
const ALICE = "user_alice"
const BOB = "user_bob"

/**
 * The retention ring is 256 events + 64 terminal (`createSseReplayBuffer`
 * defaults, `agent-sdk-runtime/src/sse.ts:29-30`). `document.changed` counts as
 * TERMINAL (`event-retention.ts:53`), so it lands in both, and overrunning the
 * gap threshold means pushing past the wider of the two.
 */
const RING_OVERRUN_FRAMES = 340

type Verdict = { scenario: string; pass: boolean; detail: string }
const verdicts: Verdict[] = []
const record = (scenario: string, pass: boolean, detail: string) => {
  verdicts.push({ scenario, pass, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${scenario} — ${detail}`)
}

async function bundleWorker() {
  const bundled = await build({
    stdin: {
      contents: `
        import { Hono } from "hono"
        import { HostedShellRoutes } from ${JSON.stringify(new URL("../../src/routes/hosted/shell.ts", import.meta.url).pathname)}
        import { LiveSyncRoom, nudgeLiveSyncRoom, liveSyncRoomNameForPrincipal } from ${JSON.stringify(new URL("../../src/deployments/hosted-workerd/live-sync-room.cf.ts", import.meta.url).pathname)}

        export { LiveSyncRoom }

        // The bearer token IS the subject. Same shape as hosted-core-app.test.ts's
        // plane() fixture verifier: it stands in for the identity provider JWT verification, which
        // cannot run locally, and nothing else.
        const verifier = async (token) => ({
          mode: "signed",
          user: { subject: token, tokenIdentifier: token, issuer: "drill" },
        })

        // Stands in for \`authority.resolveOrgId\` (the authority \`orgs._id\`). Both
        // subjects resolve to the SAME authority-internal org, so both browsers
        // are held in one room and share one retention ring — which is the
        // multi-tenancy shape the visibility filter has to be correct for.
        const resolveOrgId = async () => ${JSON.stringify(ORG)}

        const authConfig = {
          enabled: true,
          issuer: "drill",
          jwksUrl: "custom-verifier:drill",
        }

        // HostedShellRoutes closes over the namespace at construction, but the
        // binding only exists per-request in workerd. Build the router lazily,
        // once, on the first request that carries \`env\`.
        let router
        const routerFor = (env) => {
          if (!router) {
            router = new Hono().route("/", HostedShellRoutes({
              authConfig,
              verifier,
              resolveOrgId,
              liveSyncRoom: env.LIVE_SYNC_ROOM,
              // A heartbeat well beyond the drill, so periodic frames never
              // interleave with the frames being asserted on. Heartbeats carry
              // no \`id:\` by contract, but an unexpected one still lands in the
              // viewer's frame list and would muddy an assertion.
              heartbeatMs: 3600000,
            }))
          }
          return router
        }

        export default {
          async fetch(request, env, ctx) {
            const url = new URL(request.url)

            // --- drill control surface (not part of the system under test) ---

            if (url.pathname === "/__drill/viewer") {
              return new Response(VIEWER_HTML, {
                headers: { "content-type": "text/html; charset=utf-8" },
              })
            }

            // Publish a nudge through the SAME derivation the real publishers
            // use. \`room=wrong\` is the positive control: it derives a name for
            // a DIFFERENT org, so the frame lands in a room nobody is held in.
            if (url.pathname === "/__drill/publish") {
              const kind = url.searchParams.get("kind") ?? "document.changed"
              const org = url.searchParams.get("org") ?? ${JSON.stringify(ORG)}
              const owner = url.searchParams.get("owner") ?? ${JSON.stringify(ALICE)}
              const count = Number(url.searchParams.get("count") ?? "1")
              const tag = url.searchParams.get("tag") ?? "doc"

              const results = []
              for (let i = 0; i < count; i += 1) {
                const event = kind === "session.share.changed"
                  ? {
                      type: "session.share.changed",
                      phase: "granted",
                      ownerUserId: owner,
                      sessionId: "ses_drill_" + (i + 1),
                      workspaceId: "ws_drill",
                      ts: Date.now(),
                    }
                  : {
                      type: "document.changed",
                      documentId: count > 1 ? tag + "_" + (i + 1) : tag,
                      orgId: org,
                      projectId: "proj_drill",
                      ts: Date.now(),
                    }
                // The publisher-side derivation under test. Never a
                // hand-composed \`org:\${orgId}\` — that is the B3 problem-1 bug.
                const roomName = kind === "session.share.changed"
                  ? liveSyncRoomNameForPrincipal({ ownerUserId: owner, orgId: org })
                  : liveSyncRoomNameForPrincipal({ orgId: org })
                results.push(await nudgeLiveSyncRoom(env.LIVE_SYNC_ROOM, roomName, event))
              }
              return Response.json({ published: results.length, last: results[results.length - 1] })
            }

            // --- system under test ---
            return routerFor(env).fetch(request, env, ctx)
          },
        }
      `,
      loader: "ts",
      resolveDir: new URL("../../src/", import.meta.url).pathname,
      sourcefile: "live-sync-drill-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    define: {
      VIEWER_HTML: JSON.stringify(
        await readFile(new URL("./live-sync-two-browser.viewer.html", import.meta.url), "utf8"),
      ),
    },
  })
  return bundled.outputFiles[0]!.text
}

/** One browser page holding a live subscription, plus its recorded video. */
type Viewer = {
  label: string
  frames(): Promise<Array<{ type: string; id?: string; payload: unknown }>>
  status(): Promise<string>
  cursor(): Promise<string | undefined>
  connects(): Promise<number>
  /** Drops the TCP stream, as a closed laptop lid or a dropped network would. */
  drop(): Promise<void>
  reconnect(): Promise<void>
  waitForType(type: string, timeoutMs?: number): Promise<boolean>
  close(): Promise<void>
  videoPath(): Promise<string | undefined>
}

async function main() {
  console.log("live-sync two-browser drill\n")
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  const workerModule = await bundleWorker()
  const miniflare = new Miniflare({
    compatibilityDate: "2025-05-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: [{ type: "ESModule", path: "index.mjs", contents: workerModule }],
    durableObjects: { LIVE_SYNC_ROOM: "LiveSyncRoom" },
  })
  await miniflare.ready

  // Miniflare's own listener is not reliably reachable as a browser origin
  // across versions, so front it with a thin Node proxy that forwards into
  // `dispatchFetch`. The worker still executes in workerd; this only carries
  // bytes. Streaming is preserved by piping the response body through
  // unbuffered — an SSE drill that buffered here would prove nothing.
  const proxy = createServer(async (req, res) => {
    try {
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value)
        else if (Array.isArray(value)) for (const v of value) headers.append(key, v)
      }
      headers.delete("host")
      headers.delete("connection")
      const response = await miniflare.dispatchFetch(`http://drill.local${req.url}`, {
        method: req.method,
        headers,
      })
      const out: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "content-encoding") out[key] = value
      })
      res.writeHead(response.status, out)
      if (!response.body) return res.end()
      const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader()
      const pump = async () => {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          res.write(Buffer.from(next.value))
        }
      }
      req.on("close", () => void reader.cancel().catch(() => {}))
      await pump().catch(() => {})
      res.end()
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
      res.end(String(error))
    }
  })
  const port = await new Promise<number>((resolve) => {
    proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as { port: number }).port))
  })
  const origin = `http://127.0.0.1:${port}`
  console.log(`  workerd (miniflare) fronted at ${origin}\n`)

  const browser = await chromium.launch({ headless: !HEADED })

  const openViewer = async (token: string, label: string): Promise<Viewer> => {
    const context = await browser.newContext({
      viewport: { width: 720, height: 720 },
      recordVideo: { dir: OUT_DIR, size: { width: 720, height: 720 } },
    })
    const page = await context.newPage()
    await page.goto(
      `${origin}/__drill/viewer?as=${encodeURIComponent(token)}&label=${encodeURIComponent(label)}`,
    )
    await page.waitForFunction(() => (window as any).__drill?.state?.status === "open", null, {
      timeout: 15_000,
    })
    const read = <T>(fn: string) => page.evaluate(fn) as Promise<T>
    return {
      label,
      frames: () =>
        read("window.__drill.state.frames.map(f => ({ type: f.type, id: f.id, payload: f.payload }))"),
      status: () => read("window.__drill.state.status"),
      cursor: () => read("window.__drill.state.lastEventId"),
      connects: () => read("window.__drill.state.connects"),
      async drop() {
        await page.evaluate("window.__drill.stop()")
        await page.waitForFunction(() => (window as any).__drill.state.status === "closed", null, {
          timeout: 10_000,
        })
      },
      async reconnect() {
        await page.evaluate("window.__drill.start()")
        await page.waitForFunction(() => (window as any).__drill.state.status === "open", null, {
          timeout: 15_000,
        })
      },
      async waitForType(type: string, timeoutMs = 10_000) {
        // NO page interaction — the whole point. The page must update purely
        // from bytes arriving on its already-open stream.
        return await page
          .waitForFunction(
            (wanted: string) =>
              (window as any).__drill.state.frames.some((f: { type: string }) => f.type === wanted),
            type,
            { timeout: timeoutMs },
          )
          .then(() => true)
          .catch(() => false)
      },
      async close() {
        await context.close()
      },
      async videoPath() {
        return await page.video()?.path()
      },
    }
  }

  const publish = async (query: string) => {
    const response = await fetch(`${origin}/__drill/publish?${query}`)
    if (!response.ok) throw new Error(`publish failed: ${response.status} ${await response.text()}`)
    return (await response.json()) as { published: number; last: { delivered: number; held: number } }
  }

  const countOf = (frames: Array<{ type: string }>, type: string) =>
    frames.filter((frame) => frame.type === type).length

  let alice: Viewer | undefined
  let bob: Viewer | undefined
  try {
    // ---------------------------------------------------------------- scenario 1
    console.log("scenario 1 — live delivery, zero interaction")
    alice = await openViewer(ALICE, "browser A (publisher · user_alice)")
    bob = await openViewer(BOB, "browser B (observer · user_bob)")

    const bobBaseline = (await bob.frames()).length
    const live = await publish(`kind=document.changed&tag=doc_live`)
    const bobSawLive = await bob.waitForType("document.changed")
    const bobFrames = await bob.frames()
    const liveFrame = bobFrames.find((f) => f.type === "document.changed")
    record(
      "live delivery (B receives A's document.changed with no interaction)",
      bobSawLive && !!liveFrame?.id,
      bobSawLive
        ? `B received document.changed id=${liveFrame?.id}, room held ${live.last.held} / delivered ${live.last.delivered}; B's frame count ${bobBaseline} → ${bobFrames.length}, zero clicks`
        : "B never received the frame",
    )
    // The `id:` line is the whole of B3 problem 2 — without it the cursor never
    // advances and there is nothing to resume from.
    const bobCursor = await bob.cursor()
    record(
      "id: line advances the client cursor",
      !!bobCursor && bobCursor !== "0",
      `B's Last-Event-ID is ${bobCursor ?? "unset"} after one data frame`,
    )

    // ---------------------------------------------------------------- scenario 4
    // Run before the drop scenarios, while the ring is still small.
    console.log("\nscenario 4 — subject-scoped visibility inside a shared org room")
    const bobWgBefore = countOf(await bob.frames(), "session.share.changed")
    await publish(`kind=session.share.changed&owner=${ALICE}`)
    const aliceSawWg = await alice.waitForType("session.share.changed")
    // Give a wrongly-delivered frame ample time to show up before declaring absence.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const bobWgAfter = countOf(await bob.frames(), "session.share.changed")
    record(
      "visibility filter (session.share.changed reaches only its owner)",
      aliceSawWg && bobWgAfter === bobWgBefore,
      `A received it; B's session.share.changed count stayed ${bobWgBefore} despite sharing the org room`,
    )

    // ---------------------------------------------------------------- scenario 2
    console.log("\nscenario 2 — reconnect replay across a real disconnect")
    const connectsBefore = await bob.connects()
    const cursorAtDrop = await bob.cursor()
    await bob.drop()
    record(
      "B's stream is genuinely down",
      (await bob.status()) === "closed",
      `status=closed at cursor ${cursorAtDrop}`,
    )
    // Published while B holds NO connection. Nothing can reach it live.
    const missed = await publish(`kind=document.changed&tag=doc_missed_while_offline`)
    const missedIds = countOf(await bob.frames(), "document.changed")
    // How many times B had already seen the scenario-1 frame. A CURSOR-DRIVEN
    // resume replays only what was missed; a cursor-less one ("0") replays the
    // whole ring and re-delivers this frame. Counting it is what gives this
    // scenario teeth — asserting only that the missed frame arrived passes even
    // with the `id:` contract reverted, because the full-ring replay happens to
    // include it. Verified by running this drill against a reverted
    // `live-sync-room.cf.ts:773`.
    const liveSeenBefore = (await bob.frames()).filter(
      (f) => (f.payload as { documentId?: string })?.documentId === "doc_live",
    ).length
    await bob.reconnect()
    const recovered = await bob.waitForType("document.changed")
    const afterFrames = await bob.frames()
    const gotMissed = afterFrames.some(
      (f) => (f.payload as { documentId?: string })?.documentId === "doc_missed_while_offline",
    )
    const liveSeenAfter = afterFrames.filter(
      (f) => (f.payload as { documentId?: string })?.documentId === "doc_live",
    ).length
    const precise = liveSeenAfter === liveSeenBefore
    record(
      "reconnect replay (nudge published while disconnected is recovered)",
      recovered && gotMissed && precise && (await bob.connects()) > connectsBefore,
      !gotMissed
        ? "the missed frame was NOT replayed on reconnect"
        : !precise
          ? `the missed frame arrived, but so did a REDUNDANT copy of doc_live (${liveSeenBefore} → ${liveSeenAfter}): the resume replayed the whole ring rather than resuming from Last-Event-ID ${cursorAtDrop}, so recovery was not cursor-driven`
          : `B reconnected (connects ${connectsBefore} → ${await bob.connects()}) with Last-Event-ID ${cursorAtDrop}; the ring replayed doc_missed_while_offline and NOTHING else (doc_live still seen exactly ${liveSeenAfter}×), so the recovery was cursor-driven. document.changed count ${missedIds} → ${countOf(afterFrames, "document.changed")}; publish while offline reported held=${missed.last.held}`,
    )

    // ---------------------------------------------------------------- scenario 3
    console.log("\nscenario 3 — explicit gap event when the cursor falls off the ring")
    const gapCursor = await bob.cursor()
    await bob.drop()
    // Overrun the retention ring so B's cursor cannot be served.
    console.log(`  publishing ${RING_OVERRUN_FRAMES} frames to overrun the ring…`)
    await publish(`kind=document.changed&count=${RING_OVERRUN_FRAMES}&tag=flood`)
    await bob.reconnect()
    const sawGap = await bob.waitForType("stream.replay-gap")
    const gapFrame = (await bob.frames()).find((f) => f.type === "stream.replay-gap")
    const gapPayload = gapFrame?.payload as
      | { code?: string; lastEventId?: string; throughId?: string }
      | undefined
    record(
      "replay-gap event (evicted cursor yields an explicit notice, not a silent hole)",
      sawGap && gapPayload?.code === "claxedo.sse_replay_gap",
      sawGap
        ? `B reconnected at cursor ${gapCursor} after ${RING_OVERRUN_FRAMES} frames and received stream.replay-gap code=${gapPayload?.code} lastEventId=${gapPayload?.lastEventId} throughId=${gapPayload?.throughId}`
        : "no gap event; B would have silently stitched a hole-ridden log",
    )

    // ---------------------------------------------------------------- scenario 5
    console.log("\nscenario 5 — POSITIVE CONTROL: publisher rings the wrong room")
    const controlBefore = countOf(await bob.frames(), "document.changed")
    const wrongRoom = await publish(
      `kind=document.changed&org=org_internal_WRONG&tag=doc_should_never_arrive`,
    )
    // Wait as long as a passing scenario is allowed to take, so "nothing
    // arrived" is a measured absence rather than an unlucky race.
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    const controlFrames = await bob.frames()
    const controlAfter = countOf(controlFrames, "document.changed")
    const leaked = controlFrames.some(
      (f) => (f.payload as { documentId?: string })?.documentId === "doc_should_never_arrive",
    )
    record(
      "positive control (wrong-room publish reaches nobody)",
      !leaked && controlAfter === controlBefore,
      leaked
        ? "LEAKED: a frame published to another org's room reached B — the drill's other assertions are meaningless"
        : `B's document.changed count stayed ${controlBefore} for 10s; the wrong-room nudge reported held=${wrongRoom.last.held} delivered=${wrongRoom.last.delivered} (an empty room, i.e. the B3 problem-1 failure mode reproduced on demand)`,
    )
    // The control must also demonstrate that this is the SAME publish path that
    // works when the room is right — otherwise it only proves the harness broke.
    const recheck = await publish(`kind=document.changed&tag=doc_after_control`)
    const backAlive = await bob.waitForType("document.changed", 10_000)
    const gotRecheck = (await bob.frames()).some(
      (f) => (f.payload as { documentId?: string })?.documentId === "doc_after_control",
    )
    record(
      "positive control is a real negative (same path still delivers)",
      backAlive && gotRecheck,
      gotRecheck
        ? `the very next publish on the correct room arrived (held=${recheck.last.held}), so the silence above was the wrong room and not a dead harness`
        : "the correct-room publish also failed — the control is inconclusive",
    )
  } finally {
    // Videos are only finalized on context close.
    const videos: string[] = []
    for (const viewer of [alice, bob]) {
      if (!viewer) continue
      await viewer.close().catch(() => {})
      const path = await viewer.videoPath().catch(() => undefined)
      if (path) videos.push(`${viewer.label} → ${path}`)
    }
    await browser.close().catch(() => {})
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    await miniflare.dispose().catch(() => {})

    const passed = verdicts.filter((v) => v.pass).length
    console.log(`\n${"─".repeat(72)}`)
    console.log(`verdict: ${passed}/${verdicts.length} scenarios passed`)
    for (const v of verdicts) console.log(`  ${v.pass ? "PASS" : "FAIL"}  ${v.scenario}`)
    console.log("\nvideo evidence:")
    const dirVideos = await readdir(OUT_DIR).catch(() => [] as string[])
    for (const line of videos.length ? videos : dirVideos) console.log(`  ${line}`)
    await writeFile(
      `${OUT_DIR}verdicts.json`,
      JSON.stringify({ ranAt: new Date().toISOString(), verdicts, videos }, null, 2),
    )
    console.log(`\nreport: ${OUT_DIR}verdicts.json`)
    if (passed !== verdicts.length) process.exitCode = 1
  }
}

await main()
