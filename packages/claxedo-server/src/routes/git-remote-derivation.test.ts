import { describe, expect, test } from "vitest"
import { deriveRemote, parseRemotes, sanitizeRemoteUrl } from "./git-remote-derivation"

function remoteLines(entries: Array<[string, string]>) {
  return entries.flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`]).join("\n")
}

describe("remote URL sanitization", () => {
  test("keeps a plain https remote intact and displays it without the .git suffix", () => {
    const remote = sanitizeRemoteUrl("origin", "https://github.com/kyashrathore/formlink.git")
    expect(remote).toEqual({
      name: "origin",
      url: "https://github.com/kyashrathore/formlink.git",
      display: "https://github.com/kyashrathore/formlink",
      transport: "https",
      credentials_stripped: false,
    })
  })

  test("normalizes an scp-style ssh remote for display while returning the original transport URL", () => {
    const remote = sanitizeRemoteUrl("origin", "git@github.com:kyashrathore/formlink.git")
    expect(remote).toEqual({
      name: "origin",
      url: "git@github.com:kyashrathore/formlink.git",
      display: "https://github.com/kyashrathore/formlink",
      transport: "ssh",
      credentials_stripped: false,
    })
  })

  test("normalizes an ssh:// remote and keeps its bare login name", () => {
    const remote = sanitizeRemoteUrl("origin", "ssh://git@gitlab.com:2222/acme/app.git")
    expect(remote.display).toBe("https://gitlab.com:2222/acme/app")
    expect(remote.url).toBe("ssh://git@gitlab.com:2222/acme/app.git")
    expect(remote.transport).toBe("ssh")
    expect(remote.credentials_stripped).toBe(false)
  })

  test("strips a user:password userinfo component from an https remote", () => {
    const remote = sanitizeRemoteUrl("origin", "https://yash:s3cr3t-token@github.com/acme/private.git")
    expect(remote.url).toBe("https://github.com/acme/private.git")
    expect(remote.display).toBe("https://github.com/acme/private")
    expect(remote.credentials_stripped).toBe(true)
    expect(JSON.stringify(remote)).not.toContain("s3cr3t-token")
    expect(JSON.stringify(remote)).not.toContain("yash")
  })

  test("strips a bare-token userinfo component, which is how GitHub PAT remotes are written", () => {
    const remote = sanitizeRemoteUrl("origin", "https://ghp_AAAABBBBCCCCDDDD@github.com/acme/private.git")
    expect(remote.url).toBe("https://github.com/acme/private.git")
    expect(remote.credentials_stripped).toBe(true)
    expect(JSON.stringify(remote)).not.toContain("ghp_")
  })

  test("strips an ssh:// password while keeping the login name", () => {
    const remote = sanitizeRemoteUrl("origin", "ssh://git:hunter2@example.com/acme/app.git")
    expect(remote.url).toBe("ssh://example.com/acme/app.git")
    expect(remote.credentials_stripped).toBe(true)
    expect(JSON.stringify(remote)).not.toContain("hunter2")
  })

  test("scrubs the userinfo slot of a URL-shaped remote it cannot parse", () => {
    const remote = sanitizeRemoteUrl("origin", "weird+scheme://token@host/acme/app.git")
    expect(JSON.stringify(remote)).not.toContain("token@")
    expect(remote.credentials_stripped).toBe(true)
  })

  test("treats a filesystem path as a local remote rather than an scp-style host", () => {
    expect(sanitizeRemoteUrl("origin", "/Users/yash/src/app")).toMatchObject({
      url: "/Users/yash/src/app",
      display: "/Users/yash/src/app",
      transport: "local",
      credentials_stripped: false,
    })
    expect(sanitizeRemoteUrl("origin", "../sibling-repo")).toMatchObject({ transport: "local" })
  })

  test("treats a file:// remote as local", () => {
    expect(sanitizeRemoteUrl("origin", "file:///Users/yash/src/app")).toMatchObject({
      transport: "local",
      display: "/Users/yash/src/app",
    })
  })
})

describe("git remote -v parsing", () => {
  test("collapses the fetch and push pair into one remote", () => {
    const remotes = parseRemotes(remoteLines([["origin", "https://github.com/acme/app.git"]]))
    expect(remotes).toHaveLength(1)
    expect(remotes[0]).toMatchObject({ name: "origin", transport: "https" })
  })

  test("represents a remote whose push URL differs by its fetch URL", () => {
    const remotes = parseRemotes(
      ["origin\thttps://github.com/acme/app.git (fetch)", "origin\tgit@github.com:acme/app.git (push)"].join("\n"),
    )
    expect(remotes).toHaveLength(1)
    expect(remotes[0]!.url).toBe("https://github.com/acme/app.git")
  })

  test("keeps every remote and preserves order", () => {
    const remotes = parseRemotes(
      remoteLines([
        ["upstream", "https://github.com/anomalyco/opencode.git"],
        ["fork", "git@github.com:kyashrathore/Claxedo.git"],
      ]),
    )
    expect(remotes.map((remote) => remote.name)).toEqual(["upstream", "fork"])
  })

  test("ignores blank and malformed lines", () => {
    expect(parseRemotes("")).toEqual([])
    expect(parseRemotes("\n  \nnot a remote line\n")).toEqual([])
  })

  test("sanitizes credentials during parsing, not only on demand", () => {
    const remotes = parseRemotes(remoteLines([["origin", "https://ghp_LEAKME@github.com/acme/app.git"]]))
    expect(JSON.stringify(remotes)).not.toContain("ghp_LEAKME")
  })
})

describe("derivation case table", () => {
  test("no remotes at all", () => {
    expect(deriveRemote([])).toEqual({ kind: "no_remote" })
  })

  test("origin present, even alongside others", () => {
    const remotes = parseRemotes(
      remoteLines([
        ["upstream", "https://github.com/anomalyco/opencode.git"],
        ["origin", "https://github.com/kyashrathore/Claxedo.git"],
      ]),
    )
    const derived = deriveRemote(remotes)
    expect(derived.kind).toBe("origin")
    expect(derived).toMatchObject({ remote: { name: "origin" } })
  })

  test("multiple remotes with no origin is ambiguous and never guesses", () => {
    const remotes = parseRemotes(
      remoteLines([
        ["upstream", "https://github.com/anomalyco/opencode.git"],
        ["fork", "git@github.com:kyashrathore/Claxedo.git"],
      ]),
    )
    const derived = deriveRemote(remotes)
    expect(derived.kind).toBe("ambiguous")
    expect(derived).toMatchObject({ remotes: [{ name: "upstream" }, { name: "fork" }] })
  })

  test("a single non-origin remote is still ambiguous rather than assumed", () => {
    const derived = deriveRemote(parseRemotes(remoteLines([["upstream", "https://github.com/acme/app.git"]])))
    expect(derived.kind).toBe("ambiguous")
  })
})
