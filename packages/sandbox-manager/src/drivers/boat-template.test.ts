import { createHash } from "node:crypto"
import { describe, expect, test } from "vitest"
import { boatTemplateResetCommand, formatBoatRuntimeTemplate, parseBoatRuntimeTemplate } from "./boat"
import { boatRuntimeTemplateName, ensureBoatRuntimeTemplate, pruneBoatRuntimeTemplates, revokeBoatRuntimeTemplateShares, shareBoatRuntimeTemplate, type BoatRuntimeTemplateOptions } from "./boat-template"

const API = "https://boat.dev/api/v1"
const IMAGE = "ghcr.io/test/sandbox:workspace-runtime-0-10-0-5eed1d-agent-plugins-v8"
const BUILDER = "bx_bmdrsxyz"
const TEMPLATE_NAME = `claxedo-rt-${createHash("sha256").update(IMAGE).digest("hex").slice(0, 12)}`
const RESET_MARK = boatTemplateResetCommand()

type Event = { method: string; path: string; body?: any }
type NamedSnapshot = { name: string; status: "saving" | "ready" | "failed"; createdAt: string; settlesAs?: "ready" | "failed" }
type Share = { id: string; status: "active" | "revoked"; createdAt: string }

/**
 * Boat v1 as the builder meets it: one builder sandbox that is ready at once,
 * archives at a stop, resumes unhydrated and hydrates after `hydrateAfter`
 * reads; commands that succeed (the runtime answers its health probe) unless
 * the reset fails; named snapshots that settle from `saving` at the next read;
 * and share codes.
 */
function fakeBoat(options: { snapshots?: NamedSnapshot[]; saveSettlesAs?: "ready" | "failed"; resetFails?: boolean; hydrateAfter?: number; shares?: Share[] } = {}) {
  const events: Event[] = []
  const snapshots = new Map((options.snapshots ?? []).map((snapshot) => [snapshot.name, { ...snapshot }]))
  const shares = (options.shares ?? []).map((share) => ({ ...share }))
  let state = "ready"
  let hydrated = false
  let unhydratedReads = 0
  let shareCount = 0
  const sandbox = () => ({ id: BUILDER, state, hydrated })
  const seenSaving = new Set<string>()
  const read = (name: string) => {
    const snapshot = snapshots.get(name)
    if (snapshot?.status !== "saving" || !snapshot.settlesAs) return snapshot
    if (!seenSaving.has(name)) {
      seenSaving.add(name)
      return snapshot
    }
    snapshot.status = snapshot.settlesAs
    return snapshot
  }
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const path = input.replace(API, "")
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    events.push({ method, path, ...(body === undefined ? {} : { body }) })
    const json = (value: object, status = 200) => Response.json({ ok: true, ...value }, { status })
    if (path === "/sandboxes" && method === "POST") return json({ type: "sandbox.created", sandbox: sandbox() }, 202)
    if (path === `/sandboxes/${BUILDER}` && method === "GET") {
      if (!hydrated && state === "ready" && ++unhydratedReads > (options.hydrateAfter ?? 0)) hydrated = true
      return json({ type: "sandbox.info", sandbox: sandbox() })
    }
    if (path === `/sandboxes/${BUILDER}` && method === "PATCH") return json({ type: "sandbox.updated", sandbox: sandbox() })
    if (path === `/sandboxes/${BUILDER}` && method === "DELETE") return json({ type: "sandbox.deleting" }, 202)
    if (path === `/sandboxes/${BUILDER}/files`) return json({ type: "file.written", success: true })
    if (path === `/sandboxes/${BUILDER}/stop`) {
      state = "archived"
      return json({ type: "sandbox.stopping" }, 202)
    }
    if (path === `/sandboxes/${BUILDER}/resume`) {
      state = "ready"
      hydrated = false
      unhydratedReads = 0
      return json({ type: "sandbox.resuming" }, 202)
    }
    if (path === `/sandboxes/${BUILDER}/commands`) {
      const command: string = body.command
      const failed = options.resetFails && command.includes(RESET_MARK)
      const stdout = command.includes("/global/health") ? "200\nrunning" : command.startsWith("host url") ? "https://builder-2593.on.boat.dev\n" : ""
      return json({ type: "command.finished", success: !failed, exitCode: failed ? 1 : 0, stdout, stderr: "", timedOut: false })
    }
    if (path === "/named-snapshots" && method === "POST") {
      snapshots.set(body.name, { name: body.name, status: "saving", createdAt: "2026-10-15T12:00:00Z", settlesAs: options.saveSettlesAs ?? "ready" })
      return json({ type: "snapshot.named.saving", status: "saving", snapshot: snapshots.get(body.name)! }, 202)
    }
    if (path === "/named-snapshots" && method === "GET") return json({ type: "snapshot.named.list", snapshots: [...snapshots.values()] })
    const share = path.match(/^\/named-snapshots\/([^/]+)\/shares(?:\/([^/]+))?$/)
    if (share && snapshots.has(share[1])) {
      if (method === "POST") {
        const created = { id: `shr_new${++shareCount}`, codePrefix: "bsh_new", status: "active" as const, useCount: 0, lastUsedAt: null, revokedAt: null, createdAt: "2026-10-15T13:00:00Z" }
        shares.push(created)
        return json({ type: "snapshot.share.created", name: share[1], shareCode: `bsh_secret-${shareCount}`, share: created }, 201)
      }
      if (method === "GET") return json({ type: "snapshot.share.list", name: share[1], shares })
      const revoked = shares.find((entry) => entry.id === share[2])!
      revoked.status = "revoked"
      return json({ type: "snapshot.share.revoked", share: revoked })
    }
    const one = path.match(/^\/named-snapshots\/([^/]+)$/)
    if (one && snapshots.has(one[1])) {
      if (method === "GET") return json({ type: "snapshot.named.info", snapshot: read(one[1]) })
      snapshots.delete(one[1])
      return json({ type: "snapshot.named.deleted", name: one[1], status: "deleted" })
    }
    return Response.json({ ok: false, code: one ? "not_found" : "unhandled", message: `${method} ${path}` }, { status: 404 })
  }
  return { fetchImpl, events, snapshots }
}

function options(boat: ReturnType<typeof fakeBoat>, overrides: Partial<BoatRuntimeTemplateOptions> = {}): BoatRuntimeTemplateOptions {
  return {
    apiKey: "k",
    image: IMAGE,
    fetchImpl: boat.fetchImpl,
    pollIntervalMs: 0,
    driver: { provisionIntervalMs: 0, healthIntervalMs: 0 },
    ...overrides,
  }
}

const step = (event: Event) => {
  if (event.path === "/sandboxes") return "create"
  if (event.path.endsWith("/stop")) return "stop"
  if (event.path.endsWith("/resume")) return "resume"
  if (event.method === "DELETE" && event.path.startsWith("/sandboxes/")) return "delete builder"
  if (event.path === "/named-snapshots" && event.method === "POST") return "save"
  if (event.body?.command?.includes("docker pull")) return "prepare"
  if (event.body?.command?.includes(RESET_MARK)) return "reset"
  return undefined
}

describe("the Boat runtime template builder", () => {
  test("a template is named by its image reference, under the prefix", async () => {
    expect(await boatRuntimeTemplateName(IMAGE)).toBe(TEMPLATE_NAME)
    expect(await boatRuntimeTemplateName(IMAGE, "lt-b34-")).toBe(`lt-b34-${TEMPLATE_NAME.slice("claxedo-rt-".length)}`)
    await expect(boatRuntimeTemplateName(IMAGE, "Claxedo_")).rejects.toThrow("refuses the named snapshot name")
  })

  test("builds the image's template: boots the image on a builder, wakes it so Boat records the runtime's first reads, waits for the download to end, resets, stops, saves, and deletes the builder", async () => {
    const boat = fakeBoat({ hydrateAfter: 3 })
    expect(await ensureBoatRuntimeTemplate(options(boat))).toEqual({ name: TEMPLATE_NAME, built: true })
    expect(boat.events.map(step).filter(Boolean)).toEqual(["create", "prepare", "stop", "resume", "prepare", "reset", "stop", "save", "delete builder"])
    expect(boat.events.find((event) => event.path === "/sandboxes")?.body).toEqual({ noEnv: true, ttlSeconds: 1800 })
    expect(boat.events.find((event) => step(event) === "save")?.body).toEqual({ sandboxId: BUILDER, name: TEMPLATE_NAME })
    const resetAt = boat.events.findIndex((event) => step(event) === "reset")
    const hydrationReads = boat.events.slice(boat.events.findIndex((event) => step(event) === "resume"), resetAt)
      .filter((event) => event.method === "GET" && event.path === `/sandboxes/${BUILDER}`)
    expect(hydrationReads.length).toBeGreaterThan(3)
    expect(boat.snapshots.get(TEMPLATE_NAME)?.status).toBe("ready")
  })

  test("a ready template of the image is reused without a builder, and one still saving is waited for", async () => {
    for (const snapshot of [
      { name: TEMPLATE_NAME, status: "ready" as const, createdAt: "2026-10-14T00:00:00Z" },
      { name: TEMPLATE_NAME, status: "saving" as const, createdAt: "2026-10-14T00:00:00Z", settlesAs: "ready" as const },
    ]) {
      const boat = fakeBoat({ snapshots: [snapshot] })
      expect(await ensureBoatRuntimeTemplate(options(boat))).toEqual({ name: TEMPLATE_NAME, built: false })
      expect(boat.events.filter((event) => event.path.startsWith("/sandboxes"))).toEqual([])
      expect(boat.events.filter((event) => event.path === `/named-snapshots/${TEMPLATE_NAME}`)).toHaveLength(snapshot.status === "saving" ? 2 : 1)
    }
  })

  test("a template whose last save failed is built again", async () => {
    const boat = fakeBoat({ snapshots: [{ name: TEMPLATE_NAME, status: "failed", createdAt: "2026-10-14T00:00:00Z" }] })
    expect(await ensureBoatRuntimeTemplate(options(boat))).toEqual({ name: TEMPLATE_NAME, built: true })
  })

  test.each([
    ["a reset that fails saves nothing", { resetFails: true }, "template reset failed", false],
    ["a save Boat fails", { saveSettlesAs: "failed" as const }, `Boat template ${TEMPLATE_NAME} save failed`, true],
  ])("%s, and the builder is deleted all the same", async (_kind, fake, message, saved) => {
    const boat = fakeBoat(fake)
    await expect(ensureBoatRuntimeTemplate(options(boat))).rejects.toThrow(message)
    expect(boat.events.some((event) => step(event) === "save")).toBe(saved)
    expect(boat.events.at(-1)).toMatchObject({ method: "DELETE", path: `/sandboxes/${BUILDER}` })
  })

  const SHARES: Share[] = [
    { id: "shr_live", status: "active", createdAt: "2026-10-14T00:00:00Z" },
    { id: "shr_failed_deploy", status: "active", createdAt: "2026-10-14T12:00:00Z" },
    { id: "shr_gone", status: "revoked", createdAt: "2026-10-12T00:00:00Z" },
  ]

  test("a share mints a code the Worker carries with the image and revokes none, so the live Worker's code keeps working whatever the deploy does", async () => {
    const boat = fakeBoat({ snapshots: [{ name: TEMPLATE_NAME, status: "ready", createdAt: "2026-10-14T00:00:00Z" }], shares: SHARES })
    const { template, shareId } = await shareBoatRuntimeTemplate(options(boat))
    expect(template).toEqual({ image: IMAGE, shareCode: "bsh_secret-1" })
    expect(shareId).toBe("shr_new1")
    expect(parseBoatRuntimeTemplate(formatBoatRuntimeTemplate(template))).toEqual(template)
    expect(boat.events.filter((event) => event.method === "DELETE")).toEqual([])
  })

  test("once a deploy succeeded, every other active code of the deployed template is revoked, a failed deploy's among them", async () => {
    const boat = fakeBoat({ snapshots: [{ name: TEMPLATE_NAME, status: "ready", createdAt: "2026-10-14T00:00:00Z" }], shares: SHARES })
    const { shareId } = await shareBoatRuntimeTemplate(options(boat))
    expect((await revokeBoatRuntimeTemplateShares(options(boat), shareId)).sort()).toEqual(["shr_failed_deploy", "shr_live"])
    expect(boat.events.filter((event) => event.method === "DELETE").map((event) => event.path).sort()).toEqual([
      `/named-snapshots/${TEMPLATE_NAME}/shares/shr_failed_deploy`,
      `/named-snapshots/${TEMPLATE_NAME}/shares/shr_live`,
    ])
  })

  test("a deployed share the template does not hold active revokes nothing", async () => {
    const boat = fakeBoat({ snapshots: [{ name: TEMPLATE_NAME, status: "ready", createdAt: "2026-10-14T00:00:00Z" }], shares: SHARES })
    await expect(revokeBoatRuntimeTemplateShares(options(boat), "shr_gone")).rejects.toThrow("has no active share shr_gone")
    expect(boat.events.filter((event) => event.method === "DELETE")).toEqual([])
  })

  test("pruning keeps the image's template and the newest others of the prefix up to three, and never touches other names or a save in flight", async () => {
    const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`
    const boat = fakeBoat({
      snapshots: [
        { name: TEMPLATE_NAME, status: "ready", createdAt: at(1) },
        { name: "claxedo-rt-aaaaaaaaaaaa", status: "ready", createdAt: at(10) },
        { name: "claxedo-rt-bbbbbbbbbbbb", status: "ready", createdAt: at(9) },
        { name: "claxedo-rt-cccccccccccc", status: "failed", createdAt: at(8) },
        { name: "claxedo-rt-dddddddddddd", status: "ready", createdAt: at(7) },
        { name: "claxedo-rt-eeeeeeeeeeee", status: "saving", createdAt: at(2) },
        { name: "web-stack", status: "ready", createdAt: at(3) },
      ],
    })
    expect(await pruneBoatRuntimeTemplates(options(boat))).toEqual(["claxedo-rt-cccccccccccc", "claxedo-rt-dddddddddddd"])
    expect([...boat.snapshots.keys()].sort()).toEqual([TEMPLATE_NAME, "claxedo-rt-aaaaaaaaaaaa", "claxedo-rt-bbbbbbbbbbbb", "claxedo-rt-eeeeeeeeeeee", "web-stack"].sort())
  })
})
