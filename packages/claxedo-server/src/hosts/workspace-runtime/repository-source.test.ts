import { afterEach, describe, expect, test, vi } from "vitest"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { serveGitOrigin, type GitOrigin } from "../../test-support/git-origin"
import { prepareRuntimeRepository } from "./repository-source"

const active: GitOrigin[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const origin of active.splice(0)) await origin.close()
})

async function origin(commits?: number) {
  const served = await serveGitOrigin(commits)
  active.push(served)
  return {
    ...served,
    checkout: path.join(served.directory, "workspace"),
    env: { WORKSPACE_RUNTIME_SOURCE_KIND: "git", WORKSPACE_RUNTIME_GIT_REPO_URL: served.repoUrl },
  }
}

describe("sandbox repository preparation", () => {
  test("checks out the selected branch before boot, then keeps the person's work on every later boot", async () => {
    const f = await origin()
    await prepareRuntimeRepository(f.checkout, { ...f.env, WORKSPACE_RUNTIME_GIT_BRANCH: "feature" })
    expect(f.git(["branch", "--show-current"], f.checkout)).toBe("feature")
    expect(await readFile(path.join(f.checkout, "hello.txt"), "utf8")).toBe("selected repository 2\n")
    await writeFile(path.join(f.checkout, "hello.txt"), "work in progress")
    await prepareRuntimeRepository(f.checkout, f.env)
    expect(await readFile(path.join(f.checkout, "hello.txt"), "utf8")).toBe("work in progress")
    expect(f.git(["branch", "--show-current"], f.checkout)).toBe("feature")
  })

  test("without a selected branch the origin's default branch is checked out at its tip and tracked", async () => {
    const f = await origin()
    await expect(prepareRuntimeRepository(f.checkout, f.env)).resolves.toEqual({ branch: "trunk", fresh: true })
    expect(f.git(["rev-list", "--count", "HEAD"], f.checkout)).toBe("1")
    expect(f.git(["branch", "--show-current"], f.checkout)).toBe("trunk")
    expect(f.git(["rev-parse", "--abbrev-ref", "trunk@{upstream}"], f.checkout)).toBe("origin/trunk")
    expect(f.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], f.checkout)).toBe("origin/trunk")
  })

  test("a branch the origin does not have fails the preparation with git's reason", async () => {
    const f = await origin()
    await expect(prepareRuntimeRepository(f.checkout, { ...f.env, WORKSPACE_RUNTIME_GIT_BRANCH: "missing" }))
      .rejects.toThrow("couldn't find remote ref refs/heads/missing")
  })

  test("a boot whose fetch failed leaves nothing that refuses the next boot, which finishes the checkout", async () => {
    const f = await origin()
    f.served.uploads = false
    await expect(prepareRuntimeRepository(f.checkout, f.env)).rejects.toThrow()
    expect(await readdir(f.checkout)).toEqual([".git"])
    f.served.uploads = true
    await prepareRuntimeRepository(f.checkout, f.env)
    expect(await readFile(path.join(f.checkout, "hello.txt"), "utf8")).toBe("selected repository 5\n")
  })

  test("a boot interrupted after git init finishes configuring its origin on the next boot", async () => {
    const f = await origin()
    await mkdir(f.checkout)
    f.git(["init", "--quiet"], f.checkout)
    await expect(prepareRuntimeRepository(f.checkout, f.env)).resolves.toEqual({ branch: "trunk", fresh: true })
    expect(f.git(["remote", "get-url", "origin"], f.checkout)).toBe(f.repoUrl)
    expect(await readFile(path.join(f.checkout, "hello.txt"), "utf8")).toBe("selected repository 5\n")
  })

  test("an unfinished checkout holding anything but its .git is not given an origin", async () => {
    const f = await origin()
    await mkdir(f.checkout)
    f.git(["init", "--quiet"], f.checkout)
    await writeFile(path.join(f.checkout, "keep.txt"), "keep")
    await expect(prepareRuntimeRepository(f.checkout, f.env)).rejects.toThrow("nonempty workspace directory")
    expect(f.git(["remote"], f.checkout)).toBe("")
    expect(await readFile(path.join(f.checkout, "keep.txt"), "utf8")).toBe("keep")
  })

  test("the whole preparation shares one deadline, so time spent in one step is gone for the next", async () => {
    const f = await origin()
    let clock = Date.now()
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    f.served.onRequest = () => { clock += 31 * 60_000 }
    await expect(prepareRuntimeRepository(f.checkout, f.env)).rejects.toThrow("was not checked out within 30 minutes")
    expect(await readdir(f.checkout)).toEqual([".git"])
  })

  test("an already prepared checkout boots without reaching the repository, so a withdrawn credential cannot strand it", async () => {
    const f = await origin()
    await prepareRuntimeRepository(f.checkout, f.env)
    f.served.reachable = false
    await prepareRuntimeRepository(f.checkout, f.env)
    expect(f.git(["branch", "--show-current"], f.checkout)).toBe("trunk")
  })

  test("a checkout whose person pointed origin elsewhere is their work and boots as it is", async () => {
    const f = await origin()
    await prepareRuntimeRepository(f.checkout, f.env)
    f.git(["remote", "set-url", "origin", "https://github.com/acme/fork.git"], f.checkout)
    await expect(prepareRuntimeRepository(f.checkout, f.env)).resolves.toEqual({ branch: "trunk" })
    expect(f.git(["remote", "get-url", "origin"], f.checkout)).toBe("https://github.com/acme/fork.git")
  })

  test("an unfinished checkout of another origin, or files that are not a checkout, are refused and left as they are", async () => {
    const f = await origin()
    f.served.uploads = false
    await expect(prepareRuntimeRepository(f.checkout, f.env)).rejects.toThrow()
    await expect(prepareRuntimeRepository(f.checkout, { ...f.env, WORKSPACE_RUNTIME_GIT_REPO_URL: "https://github.com/other/repo.git" })).rejects.toThrow("origin is not the selected repository")
    expect(f.git(["remote", "get-url", "origin"], f.checkout)).toBe(f.env.WORKSPACE_RUNTIME_GIT_REPO_URL)
    const unrelated = path.join(path.dirname(f.checkout), "unrelated")
    await mkdir(unrelated)
    await writeFile(path.join(unrelated, "keep.txt"), "keep")
    await expect(prepareRuntimeRepository(unrelated, f.env)).rejects.toThrow("nonempty")
    expect(await readdir(unrelated)).toEqual(["keep.txt"])
  })

  test("a repository URL carrying a credential, or naming a local path, is refused before anything is written", async () => {
    const f = await origin()
    for (const repoUrl of ["https://secret@github.com/a/b.git", "file:///tmp/repo", "https://github.com/a/b.git?token=secret"]) {
      await expect(prepareRuntimeRepository(f.checkout, { ...f.env, WORKSPACE_RUNTIME_GIT_REPO_URL: repoUrl })).rejects.toThrow("credential-free")
    }
    await expect(readdir(f.checkout)).rejects.toThrow()
  })
})
