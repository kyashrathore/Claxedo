import fs from "fs"
import path from "path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export async function git(root: string, args: string[]) {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args],
    {
      cwd: root,
      timeout: 1500,
      killSignal: "SIGKILL",
    },
  )
  return stdout
}

export function text(input: unknown) {
  if (typeof input === "string") return input.trim()
  if (input instanceof Uint8Array) return new TextDecoder().decode(input).trim()
  return ""
}

export async function gitRun(dir: string, args: string[]) {
  try {
    const out = await execFileAsync("git", ["-C", dir, ...args])
    return {
      ok: true as const,
      out: text(out.stdout),
      err: text(out.stderr),
    }
  } catch (err) {
    const cause = err as { stdout?: unknown; stderr?: unknown; message?: string }
    return {
      ok: false as const,
      out: text(cause.stdout),
      err: text(cause.stderr) || text(cause.message),
    }
  }
}

export function trees(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .reduce<{ path?: string; branch?: string }[]>((all, line) => {
      if (!line) return all
      if (line.startsWith("worktree ")) {
        all.push({ path: line.slice("worktree ".length).trim() })
        return all
      }
      const last = all[all.length - 1]
      if (!last) return all
      if (line.startsWith("branch ")) last.branch = line.slice("branch ".length).trim()
      return all
    }, [])
}

async function canon(input: string) {
  const abs = path.resolve(input)
  const real = await fs.promises.realpath(abs).catch(() => abs)
  const next = path.normalize(real)
  return process.platform === "win32" ? next.toLowerCase() : next
}

/**
 * Containment guard for every caller-named directory that reaches `gitRun`,
 * `shell`, or `fs.rm` on this surface.
 *
 * `path.resolve` collapses `..` first, so `<root>/../victim` normalizes to a
 * sibling and is rejected. The `path.sep` suffix matters: a bare `startsWith`
 * would accept `/srv/project-evil` as a child of `/srv/project`.
 *
 * Same idiom as `inside()` in documents/session-hydration.ts and
 * `insideRepository()` in documents/repository-file-authority.ts — kept here so
 * the worktree handlers and their tests share one definition.
 */
export function contains(root: string, candidate: string) {
  const base = path.resolve(root)
  const target = path.resolve(candidate)
  return target === base || target.startsWith(base + path.sep)
}

export async function containsCanonical(root: string, candidate: string) {
  const [base, target] = await Promise.all([canon(root), canon(candidate)])
  return contains(base, target)
}

export async function locate(rows: { path?: string; branch?: string }[], dir: string) {
  const key = await canon(dir)
  for (const row of rows) {
    if (!row.path) continue
    if (await canon(row.path) === key) return row
  }
}

export async function defaultBranch(dir: string) {
  const remotes = await gitRun(dir, ["remote"])
  const list = remotes.ok
    ? remotes.out.split("\n").map((item) => item.trim()).filter(Boolean)
    : []
  const remote = list.includes("origin")
    ? "origin"
    : list.length === 1
      ? list[0]
      : list.includes("upstream")
        ? "upstream"
        : ""
  const head = remote
    ? await gitRun(dir, ["symbolic-ref", `refs/remotes/${remote}/HEAD`])
    : { ok: false as const, out: "", err: "" }
  if (head.ok && head.out.startsWith(`refs/remotes/${remote}/`)) {
    return {
      local: head.out.slice(`refs/remotes/${remote}/`.length),
      target: head.out.replace(/^refs\/remotes\//, ""),
    }
  }
  for (const item of ["main", "master"]) {
    const hit = await gitRun(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${item}`])
    if (hit.ok) return { local: item, target: item }
  }
  return undefined
}

export async function shell(dir: string, cmd: string) {
  try {
    const out = await execFileAsync(process.platform === "win32" ? "cmd" : "bash", process.platform === "win32" ? ["/c", cmd] : ["-lc", cmd], { cwd: dir })
    return {
      ok: true as const,
      out: text(out.stdout),
      err: text(out.stderr),
    }
  } catch (err) {
    const cause = err as { stdout?: unknown; stderr?: unknown; message?: string }
    return {
      ok: false as const,
      out: text(cause.stdout),
      err: text(cause.stderr) || text(cause.message),
    }
  }
}
