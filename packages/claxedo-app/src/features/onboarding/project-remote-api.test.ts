import { describe, expect, test } from "bun:test"
import {
  cloneAccessNote,
  parseProjectRemote,
  projectRemoteCopy,
  readProjectRemote,
  type DerivedRemote,
} from "./project-remote-api"

const origin: DerivedRemote = {
  name: "origin",
  url: "https://github.com/kyashrathore/formlink.git",
  display: "https://github.com/kyashrathore/formlink",
  transport: "https",
  credentialsStripped: false,
}

const wireRemote = (overrides: Record<string, unknown> = {}) => ({
  name: "origin",
  url: "https://github.com/kyashrathore/formlink.git",
  display: "https://github.com/kyashrathore/formlink",
  transport: "https",
  credentials_stripped: false,
  ...overrides,
})

function stubbed(body: unknown, init: { ok?: boolean } = {}) {
  return {
    fetch: async () => new Response(JSON.stringify(body), { status: init.ok === false ? 400 : 200 }),
  }
}

describe("reading a project's derived remote", () => {
  test("an origin remote comes back ready to confirm", async () => {
    const result = await readProjectRemote({
      projectPath: "/repo",
      ...stubbed({ kind: "origin", remote: wireRemote(), remotes: [wireRemote()] }),
    })

    expect(result).toEqual({ kind: "origin", remote: origin, remotes: [origin] })
    expect(projectRemoteCopy(result).cloudReady).toBe(true)
  })

  test("the directory is sent as a query parameter", async () => {
    const seen: string[] = []
    await readProjectRemote({
      projectPath: "/Users/me/my repo",
      serverUrl: "http://127.0.0.1:3001",
      fetch: async (url) => {
        seen.push(url)
        return new Response(JSON.stringify({ kind: "no_remote" }))
      },
    })

    expect(new URL(seen[0]!).searchParams.get("directory")).toBe("/Users/me/my repo")
    expect(new URL(seen[0]!).pathname).toBe("/api/claxedo/project/remote")
  })

  test.each(["no_remote", "not_a_repo", "git_timeout"] as const)("passes %s through", async (kind) => {
    expect(await readProjectRemote({ projectPath: "/repo", ...stubbed({ kind }) })).toEqual({ kind })
  })

  test("a rejected request reads as unavailable rather than as a server code", async () => {
    const result = await readProjectRemote({
      projectPath: "relative/path",
      ...stubbed({ error: { code: "project_directory_not_absolute" } }, { ok: false }),
    })

    expect(result).toEqual({ kind: "unavailable" })
    expect(projectRemoteCopy(result).message).not.toContain("project_directory")
  })

  test("an unreachable route is unavailable, not a crash", async () => {
    const result = await readProjectRemote({
      projectPath: "/repo",
      fetch: async () => {
        throw new Error("connection refused")
      },
    })

    expect(result).toEqual({ kind: "unavailable" })
  })
})

describe("parsing", () => {
  test("ambiguous keeps every candidate so the user picks rather than us guessing", () => {
    const upstream = wireRemote({ name: "upstream", display: "https://github.com/anomalyco/opencode" })
    const fork = wireRemote({ name: "fork", display: "https://github.com/me/opencode" })
    const result = parseProjectRemote({ kind: "ambiguous", remotes: [upstream, fork] })

    expect(result.kind).toBe("ambiguous")
    expect(result.kind === "ambiguous" && result.remotes.map((remote) => remote.name)).toEqual(["upstream", "fork"])
  })

  test("a remote with no display is dropped rather than falling back to url", () => {
    // The fallback IS the leak: `url` is the field that can carry userinfo.
    const result = parseProjectRemote({
      kind: "ambiguous",
      remotes: [wireRemote({ display: undefined }), wireRemote({ name: "ok" })],
    })

    expect(result.kind === "ambiguous" && result.remotes.map((remote) => remote.name)).toEqual(["ok"])
  })

  test("ambiguous with nothing left to pick is no_remote", () => {
    expect(parseProjectRemote({ kind: "ambiguous", remotes: [] })).toEqual({ kind: "no_remote" })
  })

  test("an unrecognised kind is unavailable rather than assumed", () => {
    expect(parseProjectRemote({ kind: "something_new" })).toEqual({ kind: "unavailable" })
    expect(parseProjectRemote(null)).toEqual({ kind: "unavailable" })
  })

  test("a stripped-credential flag survives so the screen can say so", () => {
    const result = parseProjectRemote({
      kind: "origin",
      remote: wireRemote({ credentials_stripped: true }),
      remotes: [],
    })

    expect(result.kind === "origin" && result.remote.credentialsStripped).toBe(true)
  })

  test("an unknown transport degrades to other rather than being trusted", () => {
    const result = parseProjectRemote({
      kind: "origin",
      remote: wireRemote({ transport: "carrier-pigeon" }),
      remotes: [],
    })
    expect(result.kind === "origin" && result.remote.transport).toBe("other")
  })
})

describe("copy per case", () => {
  test("every case says something and never leaks a raw kind", () => {
    const kinds = ["origin", "ambiguous", "no_remote", "not_a_repo", "git_timeout", "unavailable"] as const
    for (const kind of kinds) {
      const result =
        kind === "origin"
          ? ({ kind, remote: origin, remotes: [origin] } as const)
          : kind === "ambiguous"
            ? ({ kind, remotes: [origin] } as const)
            : ({ kind } as const)
      const copy = projectRemoteCopy(result)
      expect(copy.message.length).toBeGreaterThan(0)
      expect(copy.message).not.toContain(kind === "origin" ? "___never___" : kind)
    }
  })

  test("only an origin is cloud-ready", () => {
    expect(projectRemoteCopy({ kind: "origin", remote: origin, remotes: [origin] }).cloudReady).toBe(true)
    expect(projectRemoteCopy({ kind: "ambiguous", remotes: [origin] }).cloudReady).toBe(false)
    expect(projectRemoteCopy({ kind: "no_remote" }).cloudReady).toBe(false)
  })

  test("a folder with no remote is explained and offered a manual URL", () => {
    const copy = projectRemoteCopy({ kind: "no_remote" })
    expect(copy.offerManualUrl).toBe(true)
    expect(copy.message).toContain("nothing for a cloud sandbox to clone")
  })

  test("a timeout says so and offers a retry", () => {
    const copy = projectRemoteCopy({ kind: "git_timeout" })
    expect(copy.offerRetry).toBe(true)
    expect(copy.message).toContain("took too long")
  })

  test("a non-repo folder still says local work is fine", () => {
    expect(projectRemoteCopy({ kind: "not_a_repo" }).message).toContain("Local agents work here either way")
  })
})

describe("private-clone rights", () => {
  test("an SSH remote states the sandbox has no key", () => {
    expect(cloneAccessNote({ ...origin, transport: "ssh" })).toContain("no SSH key")
  })

  test("a public host says private repos need a connection or a token", () => {
    // We cannot resolve rights from a URL, so the copy names the condition
    // rather than claiming an answer we do not have.
    const note = cloneAccessNote(origin)
    expect(note).toContain("private")
    expect(note).toMatch(/connection or an access token/)
  })

  test("an unknown HTTPS host does not promise a public clone", () => {
    const note = cloneAccessNote({ ...origin, display: "https://git.internal.example/team/repo" })
    expect(note).toContain("isn't public")
  })

  test("a local remote is called unreachable from the cloud", () => {
    expect(cloneAccessNote({ ...origin, transport: "local" })).toContain("only this machine can see")
  })
})
