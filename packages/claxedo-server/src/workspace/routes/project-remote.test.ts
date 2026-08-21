import path from "node:path"
import { describe, expect, test, vi } from "vitest"
import { GitTimeoutError } from "@claxedo/workspace-runtime/host"
import { ProjectRemoteRoutes } from "./project-remote"

const localOnly = {
  enabled: false,
  mode: "local-only",
  reason: "signed/cloud auth is disabled",
} as const

function gitStub(responses: Record<string, string | Error>) {
  return vi.fn(async (args: string[]) => {
    const hit = responses[args[0] === "remote" ? "remote" : "toplevel"]
    if (hit instanceof Error) throw hit
    return hit ?? ""
  })
}

function remoteLines(entries: Array<[string, string]>) {
  return entries.flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`]).join("\n")
}

function routes(git: ReturnType<typeof gitStub>, isDirectory?: (directory: string) => Promise<boolean>) {
  return ProjectRemoteRoutes({ authConfig: localOnly, git, ...(isDirectory ? { isDirectory } : {}) })
}

async function derive(git: ReturnType<typeof gitStub>, directory = "/Users/yash/src/app") {
  const response = await routes(git).request(
    `http://localhost/remote?directory=${encodeURIComponent(directory)}`,
  )
  return { status: response.status, body: await response.json() }
}

describe("project remote derivation route", () => {
  test("returns origin with a display form when the folder has one", async () => {
    const git = gitStub({
      toplevel: "/Users/yash/src/app\n",
      remote: remoteLines([["origin", "https://github.com/kyashrathore/formlink.git"]]),
    })
    const { status, body } = await derive(git)
    expect(status).toBe(200)
    expect(body).toEqual({
      kind: "origin",
      remote: {
        name: "origin",
        url: "https://github.com/kyashrathore/formlink.git",
        display: "https://github.com/kyashrathore/formlink",
        transport: "https",
        credentials_stripped: false,
      },
      remotes: [
        {
          name: "origin",
          url: "https://github.com/kyashrathore/formlink.git",
          display: "https://github.com/kyashrathore/formlink",
          transport: "https",
          credentials_stripped: false,
        },
      ],
    })
    // The route normalizes the local directory before shelling out, and on
    // Windows path.normalize turns these POSIX-style literals into backslashes.
    expect(git).toHaveBeenCalledWith(["rev-parse", "--show-toplevel"], path.normalize("/Users/yash/src/app"))
    expect(git).toHaveBeenCalledWith(["remote", "-v"], path.normalize("/Users/yash/src/app"))
  })

  test("distinguishes a non-repository from a repository with no remotes", async () => {
    const notRepo = gitStub({ toplevel: "", remote: "" })
    await expect(derive(notRepo)).resolves.toMatchObject({ body: { kind: "not_a_repo" } })
    // `git remote -v` is never reached: outside a repository it would print
    // nothing and the two cases would be indistinguishable.
    expect(notRepo).toHaveBeenCalledTimes(1)

    const noRemote = gitStub({ toplevel: "/Users/yash/src/app\n", remote: "" })
    await expect(derive(noRemote)).resolves.toMatchObject({ body: { kind: "no_remote" } })
  })

  test("returns the candidate list without guessing when several remotes exist and none is origin", async () => {
    const git = gitStub({
      toplevel: "/Users/yash/src/app\n",
      remote: remoteLines([
        ["upstream", "https://github.com/anomalyco/opencode.git"],
        ["fork", "git@github.com:kyashrathore/Claxedo.git"],
      ]),
    })
    const { body } = await derive(git)
    expect(body).toMatchObject({
      kind: "ambiguous",
      remotes: [
        { name: "upstream", transport: "https" },
        { name: "fork", transport: "ssh", display: "https://github.com/kyashrathore/Claxedo" },
      ],
    })
    expect(body).not.toHaveProperty("remote")
  })

  test("normalizes an ssh origin for display and keeps the clone transport URL", async () => {
    const git = gitStub({
      toplevel: "/Users/yash/src/app\n",
      remote: remoteLines([["origin", "git@github.com:kyashrathore/Claxedo.git"]]),
    })
    const { body } = await derive(git)
    expect(body.remote).toMatchObject({
      url: "git@github.com:kyashrathore/Claxedo.git",
      display: "https://github.com/kyashrathore/Claxedo",
      transport: "ssh",
    })
  })

  test("never lets an embedded credential reach the response", async () => {
    const git = gitStub({
      toplevel: "/Users/yash/src/app\n",
      remote: remoteLines([["origin", "https://yash:ghp_SUPERSECRET@github.com/acme/private.git"]]),
    })
    const { body } = await derive(git)
    expect(JSON.stringify(body)).not.toContain("ghp_SUPERSECRET")
    expect(body.remote).toMatchObject({
      url: "https://github.com/acme/private.git",
      display: "https://github.com/acme/private",
      credentials_stripped: true,
    })
  })

  test("answers a git timeout with a mapped kind instead of a 500", async () => {
    // The real error from `optionalGit`, not a lookalike: the route matches on
    // `name` because the class is not identity-stable across the package
    // boundary, so a rename in workspace-runtime must fail here.
    expect(new GitTimeoutError(["rev-parse"]).name).toBe("GitTimeoutError")
    for (const stage of ["toplevel", "remote"] as const) {
      const responses = { toplevel: "/Users/yash/src/app\n", remote: "", [stage]: new GitTimeoutError(["remote"]) }
      const { status, body } = await derive(gitStub(responses))
      expect(status).toBe(200)
      expect(body).toEqual({ kind: "git_timeout" })
    }
  })

  test("rejects a relative directory rather than resolving it against the server cwd", async () => {
    const git = gitStub({ toplevel: "/Users/yash/src/app\n", remote: "" })
    const response = await routes(git).request("http://localhost/remote?directory=..%2Fsibling")
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "project_directory_not_absolute" },
    })
    expect(git).not.toHaveBeenCalled()
  })

  test("requires a directory", async () => {
    const git = gitStub({ toplevel: "", remote: "" })
    const response = await routes(git).request("http://localhost/remote")
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "project_directory_required" } })
    expect(git).not.toHaveBeenCalled()
  })

  test("reports a missing folder as not a repository instead of shelling out", async () => {
    const git = gitStub({ toplevel: "/Users/yash/src/app\n", remote: "" })
    const isDirectory = vi.fn(async () => false)
    const response = await routes(git, isDirectory).request(
      "http://localhost/remote?directory=%2FUsers%2Fyash%2Fgone",
    )
    await expect(response.json()).resolves.toEqual({ kind: "not_a_repo" })
    expect(isDirectory).toHaveBeenCalledWith(path.normalize("/Users/yash/gone"))
    expect(git).not.toHaveBeenCalled()
  })

  test("is local-only: a non-loopback caller never reaches the filesystem", async () => {
    const git = gitStub({ toplevel: "/Users/yash/src/app\n", remote: "" })
    for (const init of [{}, { headers: { authorization: "Bearer signed-token" } }]) {
      const response = await routes(git).request(
        "https://control.example.test/remote?directory=%2FUsers%2Fyash%2Fsrc%2Fapp",
        init,
      )
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "local_only_projection_route" },
      })
    }
    expect(git).not.toHaveBeenCalled()
  })
})
