import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  createHostStateStore,
  effectiveRoots,
  newHostState,
  parseHostState,
  pathWithin,
  type HostState,
} from "./host-state"
import { nodeHostStateFs } from "./host-state-node"
import { memoryHostStateFs as memoryFs } from "./fake-control-plane.test-support"

const KEY: JsonWebKey = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" }

function state(overrides: Partial<HostState> = {}): HostState {
  return {
    ...newHostState({
      hostId: "host_1",
      privateKeyJwk: KEY,
      controlPlaneUrl: "https://cp.test",
      cliRoots: [],
      storageRoot: "/var/lib/claxedo",
      now: () => 1_000,
    }),
    ...overrides,
  }
}

describe("store", () => {
  test("round-trips through an atomic temp + rename write with private modes", async () => {
    const memory = memoryFs()
    const store = createHostStateStore({ file: "/home/u/.claxedo/connect/state.json", fs: memory.fs, random: () => "r1" })

    await store.save(state())

    expect(memory.calls).toEqual([
      "mkdir /home/u/.claxedo/connect",
      "write /home/u/.claxedo/connect/state.json.r1.tmp",
      "rename /home/u/.claxedo/connect/state.json.r1.tmp -> /home/u/.claxedo/connect/state.json",
    ])
    expect(memory.dirs.get("/home/u/.claxedo/connect")).toBe(0o700)
    expect(memory.files.get("/home/u/.claxedo/connect/state.json")?.mode).toBe(0o600)
    expect(await store.load()).toEqual(state())
  })

  test("answers undefined for a missing file and refuses a torn one", async () => {
    const memory = memoryFs()
    const store = createHostStateStore({ file: "/s/state.json", fs: memory.fs })

    expect(await store.load()).toBeUndefined()

    memory.files.set("/s/state.json", { text: '{"host_id":"h","private_key_jwk":{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"},"contr', mode: 0o600 })
    await expect(store.load()).rejects.toThrow(/not JSON/)
  })

  test("removes its temp file when the write fails", async () => {
    const memory = memoryFs()
    memory.fs.rename = async () => {
      throw new Error("EXDEV")
    }
    const store = createHostStateStore({ file: "/s/state.json", fs: memory.fs, random: () => "r" })

    await expect(store.save(state())).rejects.toThrow("EXDEV")

    expect(memory.files.has("/s/state.json.r.tmp")).toBe(false)
  })

  test("finishes an interrupted bootstrap: token removed, marker cleared, enrollment kept", async () => {
    // The crash window between "enrollment persisted" and "token removed"
    // leaves both on disk. The next boot must not redeem again (the
    // enrollment exists) and must not leave the invitation file behind.
    const memory = memoryFs()
    memory.files.set("/etc/claxedo/invite.txt", { text: "chx_inv_1.a.b", mode: 0o600 })
    const store = createHostStateStore({ file: "/s/state.json", fs: memory.fs, random: () => "r" })
    const interrupted = state({
      bootstrap: { invitation_id: "a", token_file: "/etc/claxedo/invite.txt" },
      enrollment: {
        enrollment_id: "enr_1",
        owner_display: "Alice",
        org_id: "org",
        enrolled_via: "invitation",
        enrolled_at: 2,
        key_version: 1,
      },
    })
    await store.save(interrupted)

    const finished = await store.finishPendingCleanup(interrupted)

    expect(finished.bootstrap).toBeUndefined()
    expect(finished.enrollment?.enrollment_id).toBe("enr_1")
    expect(memory.files.has("/etc/claxedo/invite.txt")).toBe(false)
    expect((await store.load())?.bootstrap).toBeUndefined()
  })

  test("leaves a bootstrap without an enrollment for the caller to redeem", async () => {
    const memory = memoryFs()
    const store = createHostStateStore({ file: "/s/state.json", fs: memory.fs })
    const pending = state({ bootstrap: { invitation_id: "a", token_file: "/t" } })

    expect(await store.finishPendingCleanup(pending)).toBe(pending)
    expect(memory.calls).toEqual([])
  })
})

describe("parseHostState", () => {
  test.each([
    ["{}", /host_id/],
    ['{"host_id":"h"}', /private_key_jwk/],
    ['{"host_id":"h","private_key_jwk":{"d":"d"}}', /private_key_jwk.kty/],
    ['{"host_id":"h","private_key_jwk":{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"},"created_at":1}', /control_plane_url/],
    ['{"host_id":"h","private_key_jwk":{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"},"control_plane_url":"u","created_at":1,"storage_root":"/s","cli_roots":"x"}', /cli_roots/],
    [
      '{"host_id":"h","private_key_jwk":{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"},"control_plane_url":"u","created_at":1,"storage_root":"/s","cli_roots":[],"scope":{"allowed_roots":[]}}',
      /scope.revision/,
    ],
    [
      '{"host_id":"h","private_key_jwk":{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"},"control_plane_url":"u","created_at":1,"storage_root":"/s","cli_roots":[],"bootstrap":{"invitation_id":"a"}}',
      /bootstrap/,
    ],
  ])("names the missing field in %s", (text, message) => {
    expect(() => parseHostState(text)).toThrow(message)
  })
})

describe("roots", () => {
  test.each([
    ["/srv/api", "/srv", true],
    ["/srv", "/srv", true],
    ["/srvx", "/srv", false],
    ["/srv/../etc", "/srv", false],
    ["/srv/./api/", "/srv/", true],
    ["/anything", "/", true],
    ["relative/api", "/srv", false],
    ["/srv/api", "srv", false],
  ])("%s within %s → %s", (inner, outer, expected) => {
    expect(pathWithin(inner, outer)).toBe(expected)
  })

  /** Lexical identity: every path resolves to itself. */
  const lexical = async (path: string) => path

  const scope = (allowed_roots: string[]) => ({ revision: 1, allowed_roots, visibility: "owner" as const })

  test("no scope yet, or an empty allowed_roots, is deny-all", async () => {
    expect(await effectiveRoots({ cli_roots: ["/srv"] }, lexical)).toEqual([])
    expect(await effectiveRoots({ cli_roots: [], scope: scope([]) }, lexical)).toEqual([])
  })

  test("no cli roots ⇒ the control plane's roots", async () => {
    expect(await effectiveRoots({ cli_roots: [], scope: scope(["/srv/", "/home/u/code"]) }, lexical)).toEqual(["/home/u/code", "/srv"])
  })

  test("a cli root inside a control-plane root narrows to the cli root", async () => {
    expect(await effectiveRoots({ cli_roots: ["/srv/api"], scope: scope(["/srv"]) }, lexical)).toEqual(["/srv/api"])
  })

  test("a control-plane root inside a cli root keeps the control-plane root", async () => {
    expect(await effectiveRoots({ cli_roots: ["/srv"], scope: scope(["/srv/api"]) }, lexical)).toEqual(["/srv/api"])
  })

  test("disjoint roots leave nothing servable", async () => {
    expect(await effectiveRoots({ cli_roots: ["/home"], scope: scope(["/srv"]) }, lexical)).toEqual([])
  })

  test("relative roots contribute nothing", async () => {
    expect(await effectiveRoots({ cli_roots: ["srv"], scope: scope(["srv", "/srv"]) }, lexical)).toEqual([])
  })

  test("roots are resolved on each side before they intersect, so a cli symlink cannot widen a control-plane root", async () => {
    const links: Record<string, string> = { "/srv/link": "/private" }
    const resolve = async (path: string) => links[path] ?? path

    // Lexically `/srv/link` narrows `/srv`; resolved it is `/private`, which
    // is nowhere under `/srv`.
    expect(await effectiveRoots({ cli_roots: ["/srv/link"], scope: scope(["/srv"]) }, resolve)).toEqual([])
    // The control plane naming the same link resolves to the same place.
    expect(await effectiveRoots({ cli_roots: ["/srv/link"], scope: scope(["/srv/link"]) }, resolve)).toEqual(["/private"])
    expect(await effectiveRoots({ cli_roots: [], scope: scope(["/srv/link", "/srv"]) }, resolve)).toEqual(["/private", "/srv"])
  })

  test("a root that does not exist yet is the resolved form of its nearest existing ancestor plus the rest", async () => {
    const existing: Record<string, string> = { "/": "/", "/srv": "/srv", "/srv/link": "/private/data" }
    const resolve = async (path: string) => {
      const resolved = existing[path]
      if (resolved === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
      return resolved
    }

    expect(await effectiveRoots({ cli_roots: [], scope: scope(["/srv/link/new/deeper", "/srv/new"]) }, resolve)).toEqual([
      "/private/data/new/deeper",
      "/srv/new",
    ])
    expect(await effectiveRoots({ cli_roots: ["/srv/link/new"], scope: scope(["/private"]) }, resolve)).toEqual(["/private/data/new"])
  })
})

describe("node adapter", () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  test("writes 0600 files inside 0700 directories and treats a missing file as absent", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "host-state-"))
    dirs.push(base)
    const file = path.join(base, "connect", "state.json")
    const store = createHostStateStore({ file, fs: nodeHostStateFs() })

    expect(await store.load()).toBeUndefined()
    await store.save(state())
    await store.save(state({ cli_roots: ["/srv"] }))

    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await store.load())?.cli_roots).toEqual(["/srv"])
    expect(JSON.parse(await readFile(file, "utf8")).host_id).toBe("host_1")
    await store.fs.unlink(path.join(base, "never-there"))
    await writeFile(path.join(base, "token"), "t")
    await store.fs.unlink(path.join(base, "token"))
    expect(await store.fs.readFile(path.join(base, "token"))).toBeNull()
  })
})
