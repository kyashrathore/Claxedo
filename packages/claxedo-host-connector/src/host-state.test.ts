import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  canonicalControlPlaneUrl,
  canonicalFetchEndpointUrl,
  canonicalRelayUrl,
  ControlPlaneUrlError,
  createHostStateStore,
  effectiveRoots,
  HostEndpointUrlError,
  newHostState,
  parseHostState,
  pathWithin,
  resolveRoots,
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

/** Every required field present; each case below adds exactly the member under test. */
const SEALING_BASE =
  '{"host_id":"h","private_key_jwk":{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"},"control_plane_url":"https://cp.test","created_at":1,"storage_root":"/s","cli_roots":[]'

describe("parseHostState", () => {
  test.each([
    ["{}", /host_id/],
    ['{"host_id":"h"}', /private_key_jwk/],
    ['{"host_id":"h","private_key_jwk":{"d":"d"}}', /private_key_jwk.kty/],
    ['{"host_id":"h","private_key_jwk":{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"},"created_at":1}', /control_plane_url/],
    ['{"host_id":"h","private_key_jwk":{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"},"control_plane_url":"https://cp.test","created_at":1,"storage_root":"/s","cli_roots":"x"}', /cli_roots/],
    [
      '{"host_id":"h","private_key_jwk":{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"},"control_plane_url":"https://cp.test","created_at":1,"storage_root":"/s","cli_roots":[],"scope":{"allowed_roots":[]}}',
      /scope.revision/,
    ],
    [
      '{"host_id":"h","private_key_jwk":{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"},"control_plane_url":"https://cp.test","created_at":1,"storage_root":"/s","cli_roots":[],"bootstrap":{"invitation_id":"a"}}',
      /bootstrap/,
    ],
    [`${SEALING_BASE},"sealing_private_key_jwk":{"kty":"EC","crv":"P-256","x":"x","y":"y"}}`, /sealing_private_key_jwk.d/],
    [`${SEALING_BASE},"provider_config":{"sealed":"mseal1.a.b.c"}}`, /provider_config.revision/],
    [`${SEALING_BASE},"provider_config":{"revision":1,"sealed":7}}`, /provider_config.sealed/],
  ])("names the missing field in %s", (text, message) => {
    expect(() => parseHostState(text)).toThrow(message)
  })

  test("carries the sealing key and the sealed configuration back unchanged", () => {
    const state = parseHostState(
      `${SEALING_BASE},"sealing_private_key_jwk":{"kty":"EC","crv":"P-256","x":"sx","y":"sy","d":"sd"},"provider_config":{"revision":4,"sealed":"mseal1.a.b.c"}}`,
    )
    expect(state.sealing_private_key_jwk).toEqual({ kty: "EC", crv: "P-256", x: "sx", y: "sy", d: "sd" })
    expect(state.provider_config).toEqual({ revision: 4, sealed: "mseal1.a.b.c" })
  })

  test("a recorded withdrawal is a revision with no blob, not an absent record", () => {
    expect(parseHostState(`${SEALING_BASE},"provider_config":{"revision":9,"sealed":null}}`).provider_config).toEqual({
      revision: 9,
      sealed: null,
    })
  })

  test("a file edited to name a cleartext control plane does not load", () => {
    // The state file is where an endpoint outlives the run that accepted it:
    // if reading it back re-enabled http://, every check before the first
    // write would be one reboot deep.
    const text = SEALING_BASE.replace('"https://cp.test"', '"http://cp.test"') + "}"

    expect(() => parseHostState(text)).toThrow(ControlPlaneUrlError)
    expect(() => parseHostState(text)).toThrow(/must be https/)
  })

  test("a loopback http control plane loads, canonicalized", () => {
    expect(parseHostState(SEALING_BASE.replace('"https://cp.test"', '"http://127.0.0.1:2593/"') + "}").control_plane_url).toBe(
      "http://127.0.0.1:2593",
    )
  })

  test("recorded endpoints load canonicalized, and a file edited to name an undialable one does not load", () => {
    const endpoints =
      '"relay":{"url":"https://relay.test/","jwksUrl":"https://relay.test/.well-known/jwks.json"},"authority":{"sessionAuthorityUrl":"https://cp.test/api/runtime-authority/session-authorize"}'
    expect(parseHostState(`${SEALING_BASE},${endpoints}}`)).toMatchObject({
      relay: { url: "https://relay.test", jwksUrl: "https://relay.test/.well-known/jwks.json" },
      authority: { sessionAuthorityUrl: "https://cp.test/api/runtime-authority/session-authorize" },
    })

    const cleartextRelay = `${SEALING_BASE},"relay":{"url":"ws://attacker.test","jwksUrl":"https://relay.test/jwks.json"}}`
    expect(() => parseHostState(cleartextRelay)).toThrow(HostEndpointUrlError)
    expect(() => parseHostState(cleartextRelay)).toThrow(/relay\.url/)

    const fileJwks = `${SEALING_BASE},"relay":{"url":"https://relay.test","jwksUrl":"file:///etc/keys"}}`
    expect(() => parseHostState(fileJwks)).toThrow(/relay\.jwksUrl/)

    const scriptedAuthority = `${SEALING_BASE},"authority":{"sessionAuthorityUrl":"javascript:fetch(1)"}}`
    expect(() => parseHostState(scriptedAuthority)).toThrow(/authority\.sessionAuthorityUrl/)
  })
})

describe("canonicalRelayUrl and canonicalFetchEndpointUrl", () => {
  test.each([
    ["https://relay.test", "https://relay.test"],
    ["wss://relay.test:8443", "wss://relay.test:8443"],
    ["wss://relay.test/", "wss://relay.test"],
    ["  https://RELAY.test/edge/  ", "https://relay.test/edge"],
    ["ws://localhost:4100", "ws://localhost:4100"],
    ["http://127.0.0.1:4100", "http://127.0.0.1:4100"],
    ["ws://[::1]:4100", "ws://[::1]:4100"],
  ])("relay %s → %s", (input, expected) => {
    expect(canonicalRelayUrl(input)).toBe(expected)
  })

  test.each([
    ["ws://relay.test", /wss:\/\/ or https/],
    ["http://relay.test", /wss:\/\/ or https/],
    ["ws://sub.localhost", /wss:\/\/ or https/],
    ["file:///etc/passwd", /wss:\/\/ or https/],
    ["javascript:fetch(1)", /wss:\/\/ or https/],
    ["wss://user:pass@relay.test", /no user or password/],
    ["wss://relay.test?t=1", /no query or fragment/],
    ["wss://relay.test/#f", /no query or fragment/],
    ["not a url", /is not a URL/],
  ])("relay refuses %s", (input, message) => {
    expect(() => canonicalRelayUrl(input)).toThrow(HostEndpointUrlError)
    expect(() => canonicalRelayUrl(input)).toThrow(message)
  })

  test.each([
    ["https://relay.test/.well-known/jwks.json", "https://relay.test/.well-known/jwks.json"],
    ["http://localhost:3000/api/runtime-authority/session-authorize", "http://localhost:3000/api/runtime-authority/session-authorize"],
  ])("fetch endpoint %s → %s", (input, expected) => {
    expect(canonicalFetchEndpointUrl(input, "authority.session_authority_url")).toBe(expected)
  })

  test.each([
    ["http://relay.test/jwks.json", /must be https/],
    ["ws://relay.test/jwks.json", /must be https/],
    ["ftp://relay.test/jwks.json", /must be https/],
    ["https://user@keys.test/jwks.json", /no user or password/],
  ])("fetch endpoint refuses %s", (input, message) => {
    expect(() => canonicalFetchEndpointUrl(input, "relay.jwks_url")).toThrow(HostEndpointUrlError)
    expect(() => canonicalFetchEndpointUrl(input, "relay.jwks_url")).toThrow(message)
    expect(() => canonicalFetchEndpointUrl(input, "relay.jwks_url")).toThrow(/relay\.jwks_url/)
  })
})

describe("canonicalControlPlaneUrl", () => {
  test.each([
    ["https://app.claxedo.com", "https://app.claxedo.com"],
    ["https://app.claxedo.com/", "https://app.claxedo.com"],
    ["https://app.claxedo.com///", "https://app.claxedo.com"],
    ["  https://app.claxedo.com  ", "https://app.claxedo.com"],
    ["https://app.claxedo.com:8443/edge/", "https://app.claxedo.com:8443/edge"],
    ["https://APP.claxedo.com", "https://app.claxedo.com"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:2593", "http://127.0.0.1:2593"],
    ["http://[::1]:2593", "http://[::1]:2593"],
    ["https://localhost:3000", "https://localhost:3000"],
  ])("%s → %s", (input, expected) => {
    expect(canonicalControlPlaneUrl(input)).toBe(expected)
  })

  test.each([
    ["http://app.claxedo.com", /must be https/],
    ["http://cp.internal:8080", /must be https/],
    // Each of these resolves off-box, and an `http:` request to it is on a
    // network; only the three exact loopback names are not.
    ["http://localhost.attacker.test", /must be https/],
    ["http://sub.localhost", /must be https/],
    ["http://127.0.0.2", /must be https/],
    ["http://0.0.0.0", /must be https/],
    ["http://[::ffff:127.0.0.1]", /must be https/],
    ["ws://app.claxedo.com", /must be https/],
    ["file:///etc/passwd", /must be https/],
    ["javascript:fetch(1)", /must be https/],
    ["https://user:pass@app.claxedo.com", /no user or password/],
    ["https://user@app.claxedo.com", /no user or password/],
    ["https://app.claxedo.com/?next=https://attacker.test", /no query or fragment/],
    ["https://app.claxedo.com?x=1", /no query or fragment/],
    ["https://app.claxedo.com#f", /no query or fragment/],
    ["https://app.claxedo.com/edge%2f..", /plain path prefix/],
    ["https://app.claxedo.com//edge", /plain path prefix/],
    ["app.claxedo.com", /is not a URL/],
    ["/api/claxedo", /is not a URL/],
    ["", /is not a URL/],
  ])("refuses %s", (input, message) => {
    expect(() => canonicalControlPlaneUrl(input)).toThrow(ControlPlaneUrlError)
    expect(() => canonicalControlPlaneUrl(input)).toThrow(message)
  })

  test("composing a signed request's path onto a base leaves the path the signature covers", () => {
    // The canonical base is what `controlPlaneRequestUrl` concatenates onto,
    // so a base written with a trailing slash signs the same path as one
    // without — and a base with a prefix keeps it.
    expect(new URL(canonicalControlPlaneUrl("https://app.claxedo.com/") + "/api/claxedo/host/enrollments/heartbeat").pathname).toBe(
      "/api/claxedo/host/enrollments/heartbeat",
    )
    expect(new URL(canonicalControlPlaneUrl("https://app.claxedo.com/edge") + "/api/claxedo/host/enrollments/heartbeat").pathname).toBe(
      "/edge/api/claxedo/host/enrollments/heartbeat",
    )
  })

  test("a state is never minted for an endpoint the machine may not talk to", () => {
    expect(() => state({})).not.toThrow()
    expect(() =>
      newHostState({ hostId: "host_1", privateKeyJwk: KEY, controlPlaneUrl: "http://cp.test", cliRoots: [], storageRoot: "/s" }),
    ).toThrow(ControlPlaneUrlError)
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

describe("root pinning", () => {
  const scope = (allowed_roots: string[]) => ({ revision: 1, allowed_roots, visibility: "owner" as const })
  /** A filesystem where `/srv/projects` does not exist yet and can later be made a symlink. */
  const filesystem = (links: Record<string, string>) => async (path: string) => {
    if (path in links) return links[path]
    if (path === "/" || path === "/srv" || path === "/home" || path === "/home/victim") return path
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
  }

  test("the first resolution of a root records its canonical form", async () => {
    const resolved = await resolveRoots({ cli_roots: [], scope: scope(["/srv/projects", "/srv/link/"]) }, filesystem({ "/srv/link": "/home/victim" }))

    expect(resolved).toEqual({
      roots: ["/home/victim", "/srv/projects"],
      canonical: { "/srv/projects": "/srv/projects", "/srv/link/": "/home/victim" },
      drifted: [],
    })
  })

  test("a root whose canonical form moved since it was recorded is refused, and stays recorded as it was", async () => {
    const first = await resolveRoots({ cli_roots: [], scope: scope(["/srv/projects", "/srv/other"]) }, filesystem({}))
    expect(first.roots).toEqual(["/srv/other", "/srv/projects"])

    const later = await resolveRoots(
      { cli_roots: [], scope: scope(["/srv/projects", "/srv/other"]), roots_canonical: first.canonical },
      filesystem({ "/srv/projects": "/home/victim" }),
    )

    expect(later.roots, "only the root that still resolves where it did serves").toEqual(["/srv/other"])
    expect(later.drifted).toEqual([{ root: "/srv/projects", recorded: "/srv/projects", resolved: "/home/victim" }])
    expect(later.canonical, "the drifted root keeps its recorded form until reset").toEqual(first.canonical)
    expect(await effectiveRoots({ cli_roots: [], scope: scope(["/srv/projects"]), roots_canonical: first.canonical }, filesystem({ "/srv/projects": "/home/victim" }))).toEqual([])
  })

  test("a cli root is pinned too, and a recorded root that is no longer declared is dropped from the record", async () => {
    const first = await resolveRoots({ cli_roots: ["/srv/projects/app"], scope: scope(["/srv/projects"]) }, filesystem({}))
    expect(first.canonical).toEqual({ "/srv/projects": "/srv/projects", "/srv/projects/app": "/srv/projects/app" })

    const later = await resolveRoots(
      { cli_roots: [], scope: scope(["/srv/projects"]), roots_canonical: first.canonical },
      filesystem({ "/srv/projects/app": "/home/victim" }),
    )

    expect(later).toEqual({ roots: ["/srv/projects"], canonical: { "/srv/projects": "/srv/projects" }, drifted: [] })
  })

  test("without a record, the pins are what the roots resolve to now — a reset re-records", async () => {
    const reset = await resolveRoots({ cli_roots: [], scope: scope(["/srv/projects"]) }, filesystem({ "/srv/projects": "/home/victim" }))

    expect(reset).toEqual({ roots: ["/home/victim"], canonical: { "/srv/projects": "/home/victim" }, drifted: [] })
  })

  test("roots_canonical round-trips through the state file and refuses a non-string entry", () => {
    const text = JSON.stringify({ ...state(), roots_canonical: { "/srv": "/private/srv" } })
    expect(parseHostState(text).roots_canonical).toEqual({ "/srv": "/private/srv" })
    expect(() => parseHostState(JSON.stringify({ ...state(), roots_canonical: { "/srv": 1 } }))).toThrow("roots_canonical")
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
