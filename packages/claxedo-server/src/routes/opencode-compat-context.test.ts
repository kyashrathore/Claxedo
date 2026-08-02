import fs from "fs"
import os from "os"
import path from "path"
import { Hono } from "hono"
import { afterAll, describe, expect, test } from "vitest"
import { workspacePath } from "./opencode-compat-context"

/**
 * Regression pin for §6.6 of the 2026-07-27 Cloud security review:
 * `workspacePath()` resolved a caller-supplied `?path=` against the workspace
 * root with no containment check, and the result went straight to
 * `fs.readdir`/`fs.readFile` in opencode-compat-file-browser.ts.
 *
 * Self-host only (this router is not mounted on the hosted Worker), but a
 * signed self-host box is remotely reachable by design.
 */

const ROOT = path.resolve("/srv/project")

function serve(root: () => string) {
  const app = new Hono()
  app.get("/file", async (c) => c.json({ path: await workspacePath(root(), c.req.query("path")) }))
  return app
}

describe("workspacePath containment", () => {
  const escapes: Array<[name: string, input: string]> = [
    ["a single parent hop", ".."],
    ["a relative traversal", "../secret.txt"],
    ["a deep relative traversal", "../../../../etc/passwd"],
    ["traversal buried mid-path", "src/../../../etc/passwd"],
    ["traversal with a leading current-dir", "./../../etc/passwd"],
    ["a trailing-slash traversal", "../"],
    ["an absolute path outside the root", "/etc/passwd"],
    ["an absolute path to the filesystem root", "/"],
    ["an absolute traversal that normalizes out of the root", "/srv/project/../../etc/passwd"],
    // The prefix-confusion case: a bare `startsWith(root)` accepts every one
    // of these, because "/srv/project-evil" starts with "/srv/project".
    ["a sibling root sharing the root's prefix", "/srv/project-evil/secret"],
    ["the sibling root itself", "/srv/project-evil"],
    ["a relative hop into the sibling root", "../project-evil/secret"],
  ]

  test.each(escapes)("rejects %s", async (_name, input) => {
    await expect(workspacePath(ROOT, input)).rejects.toThrow()
  })

  test("rejects rather than clamping to the root", async () => {
    // Silently rewriting an escaping path to `root` would answer a traversal
    // probe with a plausible 200 and hide the attempt entirely.
    expect(await workspacePath(ROOT, "ok.txt")).toBe(path.join(ROOT, "ok.txt"))
    await expect(workspacePath(ROOT, "../../etc/passwd")).rejects.toThrow()
  })

  test("the rejection is a 400 with the compat error shape", async () => {
    const res = await serve(() => ROOT).request("/file?path=../../etc/passwd")

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        code: "opencode_path_outside_workspace",
        message: "path resolves outside the workspace root",
      },
    })
  })

  test("percent-encoded traversal is decoded before the guard sees it", async () => {
    // Hono decodes query params, so `..%2F..%2F` reaches the helper as `../../`.
    // Guarding after decoding is the whole point — a guard that ran first would
    // pass the encoded form straight through to `fs`.
    const app = serve(() => ROOT)

    for (const encoded of [
      "..%2F..%2Fetc%2Fpasswd",
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "%2Fetc%2Fpasswd",
      "..%2f..%2f..%2fsrv%2fproject-evil",
    ]) {
      const res = await app.request(`/file?path=${encoded}`)
      expect(res.status, encoded).toBe(400)
    }
  })

  test("double-encoded input stays a literal filename inside the root", async () => {
    // One decode pass, and only one: `%252e%252e%252f` decodes to the literal
    // `%2e%2e%2f`, which is a filename, not a traversal. Pinned so nobody
    // "fixes" this by adding a second decodeURIComponent — that is how
    // double-decoding bugs get introduced.
    const res = await serve(() => ROOT).request("/file?path=%252e%252e%252fsecret")

    expect(res.status).toBe(200)
    expect((await res.json()).path).toBe(path.join(ROOT, "%2e%2e%2fsecret"))
  })
})

describe("workspacePath still resolves legitimate in-root paths", () => {
  test("relative paths resolve under the root", async () => {
    expect(await workspacePath(ROOT, "src/index.ts")).toBe(path.join(ROOT, "src", "index.ts"))
    expect(await workspacePath(ROOT, "./src/index.ts")).toBe(path.join(ROOT, "src", "index.ts"))
    expect(await workspacePath(ROOT, "src/../lib/util.ts")).toBe(path.join(ROOT, "lib", "util.ts"))
  })

  test("the root itself and the empty input resolve to the root", async () => {
    expect(await workspacePath(ROOT, undefined)).toBe(ROOT)
    expect(await workspacePath(ROOT, "")).toBe(ROOT)
    expect(await workspacePath(ROOT, "   ")).toBe(ROOT)
    expect(await workspacePath(ROOT, ".")).toBe(ROOT)
    expect(await workspacePath(ROOT, ROOT)).toBe(ROOT)
  })

  test("absolute in-root paths keep working", async () => {
    // Load-bearing: the directory listing returns an `absolute` field per entry
    // and the client round-trips it back as `?path=`. Containment must not
    // break that.
    expect(await workspacePath(ROOT, path.join(ROOT, "src", "index.ts"))).toBe(path.join(ROOT, "src", "index.ts"))
  })

  test("the file browser still reads a real in-root file end to end", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-compat-context-"))
    try {
      await fs.promises.mkdir(path.join(directory, "nested"))
      await fs.promises.writeFile(path.join(directory, "nested", "note.txt"), "hello")

      const resolved = await workspacePath(directory, "nested/note.txt")

      expect(await fs.promises.readFile(resolved, "utf8")).toBe("hello")
      // ...and the escape from that same real root is refused.
      await expect(workspacePath(directory, "../../../etc/passwd")).rejects.toThrow()
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true })
    }
  })
})

/**
 * The residual the containment change left open on purpose: containment was
 * LEXICAL, so a symlink *inside* the root pointing outward resolved straight
 * through — a string compare cannot see one. Every "rejects" case below passes
 * the lexical guard and needs real canonicalization to fail.
 *
 * Real symlinks on a real temp dir; nothing here is mocked. `os.tmpdir()` is
 * itself a symlink on macOS (`/var` -> `/private/var`), which is why the root
 * has to be canonicalized too rather than compared raw.
 */
const fixture = await (async () => {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-compat-symlink-"))
  const link = (target: string, name: string, type: "dir" | "file") =>
    fs.promises.symlink(target, path.join(base, name), type)
  try {
    await fs.promises.mkdir(path.join(base, "outside", "nested"), { recursive: true })
    await fs.promises.writeFile(path.join(base, "outside", "secret.txt"), "stolen")
    await fs.promises.writeFile(path.join(base, "outside", "nested", "deep.txt"), "stolen")

    await fs.promises.mkdir(path.join(base, "root", "real"), { recursive: true })
    await fs.promises.writeFile(path.join(base, "root", "ok.txt"), "fine")
    await fs.promises.writeFile(path.join(base, "root", "real", "inner.txt"), "fine")

    // Escaping links.
    await link(path.join(base, "outside"), path.join("root", "escape-dir"), "dir")
    await link(path.join(base, "outside", "secret.txt"), path.join("root", "escape-file"), "file")
    // A link to a link to outside — resolution has to follow the whole chain.
    await link(path.join(base, "root", "escape-dir"), path.join("root", "hop"), "dir")
    // Dangling: exists as a link, but `realpath` throws ENOENT on it exactly
    // like a path that was never there.
    await link(path.join(base, "outside", "never.txt"), path.join("root", "dangling"), "file")
    // Relative form, in case anything ever resolves link targets against cwd.
    await link(path.join("..", "outside"), path.join("root", "relative-escape"), "dir")

    // Links that stay inside. These prove the fix contains symlinks rather than
    // banning them.
    await link(path.join(base, "root", "real"), path.join("root", "inside-dir"), "dir")
    await link(path.join(base, "root", "ok.txt"), path.join("root", "inside-file"), "file")

    // The root itself reached through a symlink.
    await link(path.join(base, "root"), "rootlink", "dir")
    return base
  } catch {
    // Symlink creation needs privileges on some platforms (Windows without
    // developer mode). Skip loudly via `describe.skipIf` rather than letting
    // the assertions quietly no-op.
    await fs.promises.rm(base, { recursive: true, force: true })
    return undefined
  }
})()

describe.skipIf(!fixture)("workspacePath resolves symlinks before containing", () => {
  afterAll(async () => {
    if (fixture) await fs.promises.rm(fixture, { recursive: true, force: true })
  })

  const at = (...segments: string[]) => path.join(fixture!, ...segments)
  const root = () => at("root")

  const escapes: Array<[name: string, input: string]> = [
    ["a symlink to a directory outside the root", "escape-dir"],
    ["a file beneath a directory symlink that escapes", "escape-dir/secret.txt"],
    ["a symlink straight to a file outside the root", "escape-file"],
    ["a nested path beneath an escaping directory symlink", "escape-dir/nested/deep.txt"],
    ["a chain of symlinks that ends outside the root", "hop/secret.txt"],
    ["a relative-target symlink that escapes", "relative-escape/secret.txt"],
  ]

  test.each(escapes)("rejects %s", async (_name, input) => {
    await expect(workspacePath(root(), input)).rejects.toThrow()
  })

  test("rejects an escaping symlink handed back as an absolute path", async () => {
    // The directory listing returns an `absolute` field the client round-trips
    // as `?path=`, so the absolute form has to be guarded too.
    await expect(workspacePath(root(), at("root", "escape-dir", "secret.txt"))).rejects.toThrow()
  })

  test("rejects a not-yet-existing path underneath an escaping symlink", async () => {
    // The trap in this whole class of fix. `realpath` throws ENOENT here just
    // like it does for a legitimate file about to be created, so "fall back to
    // the lexical check on ENOENT" reopens the hole for precisely the paths an
    // attacker crafts. `escape-dir` still resolves to `../outside`.
    await expect(workspacePath(root(), "escape-dir/not-yet.txt")).rejects.toThrow()
    await expect(workspacePath(root(), "escape-dir/nested/not-yet.txt")).rejects.toThrow()
  })

  test("rejects a dangling symlink that points outside the root", async () => {
    // `realpath` fails on a dangling link, so walking up to the deepest
    // resolvable ancestor would treat `dangling` as a plain filename and call
    // it contained. The link has to be read by hand.
    await expect(workspacePath(root(), "dangling")).rejects.toThrow()
  })

  test("the symlink rejection is the same typed 400, not an fs error", async () => {
    const res = await serve(root).request("/file?path=escape-dir/secret.txt")

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        code: "opencode_path_outside_workspace",
        message: "path resolves outside the workspace root",
      },
    })
  })

  test("an ordinary in-root path still resolves and reads", async () => {
    const resolved = await workspacePath(root(), "real/inner.txt")

    expect(resolved).toBe(at("root", "real", "inner.txt"))
    expect(await fs.promises.readFile(resolved, "utf8")).toBe("fine")
  })

  test("a symlink that stays inside the root still works", async () => {
    // The control that proves the fix did not simply ban symlinks. Both of
    // these resolve through a link and land back inside the root.
    const viaDir = await workspacePath(root(), "inside-dir/inner.txt")
    const viaFile = await workspacePath(root(), "inside-file")

    expect(await fs.promises.readFile(viaDir, "utf8")).toBe("fine")
    expect(await fs.promises.readFile(viaFile, "utf8")).toBe("fine")
    // The lexical path is returned, not the canonical one: callers rebuild
    // client-visible paths with `path.relative(root, …)`, which a canonicalized
    // return would break.
    expect(viaDir).toBe(at("root", "inside-dir", "inner.txt"))
  })

  test("a not-yet-existing path in a legitimate directory still resolves", async () => {
    // The create case. A write path targeting a new file must survive, and so
    // must a new file under a directory that does not exist yet.
    expect(await workspacePath(root(), "real/not-yet.txt")).toBe(at("root", "real", "not-yet.txt"))
    expect(await workspacePath(root(), "real/new-dir/not-yet.txt")).toBe(at("root", "real", "new-dir", "not-yet.txt"))
    expect(await workspacePath(root(), "brand-new.txt")).toBe(at("root", "brand-new.txt"))
  })

  test("a workspace root that is itself a symlink still works", async () => {
    // Canonicalizing only the candidate would reject every path under a
    // symlinked root — including every macOS temp dir, where `/var` is a link
    // to `/private/var`.
    const linked = at("rootlink")

    expect(await fs.promises.readFile(await workspacePath(linked, "ok.txt"), "utf8")).toBe("fine")
    expect(await fs.promises.readFile(await workspacePath(linked, "real/inner.txt"), "utf8")).toBe("fine")
    expect(await workspacePath(linked, "real/not-yet.txt")).toBe(path.join(linked, "real", "not-yet.txt"))
    // ...and the escapes are still refused through the symlinked root.
    await expect(workspacePath(linked, "escape-dir/secret.txt")).rejects.toThrow()
    await expect(workspacePath(linked, "../outside/secret.txt")).rejects.toThrow()
  })
})
