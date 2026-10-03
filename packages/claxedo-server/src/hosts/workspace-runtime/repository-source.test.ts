import { afterEach, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareRuntimeRepository } from "./repository-source"

const active: { directory: string; server: Server }[] = []
afterEach(async () => {
  for (const { directory, server } of active.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

async function origin() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runtime-source-"))
  const repository = path.join(directory, "origin")
  await mkdir(repository)
  const env = { ...process.env, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(directory, "gitconfig") }
  const git = (args: string[], cwd = repository) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git(["init", "--initial-branch=trunk"])
  await writeFile(path.join(repository, "hello.txt"), "selected repository\n")
  git(["add", "."])
  git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"])
  git(["branch", "feature"])
  git(["update-server-info"])
  const served = { reachable: true, objects: true }
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url!, "http://localhost").pathname
    const file = path.resolve(repository, ".git", pathname.slice(1))
    if (!served.reachable || !file.startsWith(path.join(repository, ".git") + path.sep) || (!served.objects && pathname.startsWith("/objects/"))) {
      res.writeHead(404).end()
      return
    }
    try {
      res.end(await readFile(file))
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  active.push({ directory, server })
  const { port } = server.address() as { port: number }
  return {
    checkout: path.join(directory, "workspace"),
    served,
    git,
    env: { WORKSPACE_RUNTIME_SOURCE_KIND: "git", WORKSPACE_RUNTIME_GIT_REPO_URL: `http://127.0.0.1:${port}/` },
  }
}

describe("sandbox repository preparation", () => {
  test("checks out the selected branch before boot, then keeps the person's work on every later boot", async () => {
    const f = await origin()
    await prepareRuntimeRepository(f.checkout, { ...f.env, WORKSPACE_RUNTIME_GIT_BRANCH: "feature" })
    expect(f.git(["branch", "--show-current"], f.checkout)).toBe("feature")
    expect(await readFile(path.join(f.checkout, "hello.txt"), "utf8")).toBe("selected repository\n")
    await writeFile(path.join(f.checkout, "hello.txt"), "work in progress")
    await prepareRuntimeRepository(f.checkout, f.env)
    expect(await readFile(path.join(f.checkout, "hello.txt"), "utf8")).toBe("work in progress")
    expect(f.git(["branch", "--show-current"], f.checkout)).toBe("feature")
  })

  test("without a selected branch the origin's default branch is checked out and tracked", async () => {
    const f = await origin()
    await prepareRuntimeRepository(f.checkout, f.env)
    expect(f.git(["branch", "--show-current"], f.checkout)).toBe("trunk")
    expect(f.git(["rev-parse", "--abbrev-ref", "trunk@{upstream}"], f.checkout)).toBe("origin/trunk")
  })

  test("a boot whose fetch failed leaves nothing that refuses the next boot, which finishes the checkout", async () => {
    const f = await origin()
    f.served.objects = false
    await expect(prepareRuntimeRepository(f.checkout, f.env)).rejects.toThrow()
    expect(await readdir(f.checkout)).toEqual([".git"])
    f.served.objects = true
    await prepareRuntimeRepository(f.checkout, f.env)
    expect(await readFile(path.join(f.checkout, "hello.txt"), "utf8")).toBe("selected repository\n")
  })

  test("an already prepared checkout boots without reaching the repository, so a withdrawn credential cannot strand it", async () => {
    const f = await origin()
    await prepareRuntimeRepository(f.checkout, f.env)
    f.served.reachable = false
    await prepareRuntimeRepository(f.checkout, f.env)
    expect(f.git(["branch", "--show-current"], f.checkout)).toBe("trunk")
  })

  test("a checkout of another origin, or files that are not a checkout, are refused and left as they are", async () => {
    const f = await origin()
    await prepareRuntimeRepository(f.checkout, f.env)
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
