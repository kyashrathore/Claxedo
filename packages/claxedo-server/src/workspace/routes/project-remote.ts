/**
 * Derives the git remote a local folder would be cloned from, so setup can
 * satisfy the cloud path from the folder the user already picked instead of
 * asking a second question (plan 2026-07-31-001 §4.2).
 *
 * Local-only by construction: it reads the caller's filesystem, which is
 * meaningful on the machine the desktop app runs on and meaningless through
 * signed/team control-plane access.
 *
 * Deriving is a convenience and never a licence to skip confirmation — a wrong
 * guess clones the wrong codebase into a paid sandbox — so every answer carries
 * the derived URL for the caller to show before anything is created.
 */
import path from "node:path"
import { Hono } from "hono"
import { z } from "zod"
import { localOnlyProjection } from "@claxedo/local-server/platform/http/local-only-projection"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { deriveRemote, parseRemotes, type DerivedRemote } from "../git-remote-derivation"

const query = z.object({
  directory: z.string().trim().min(1).max(4096),
})

export type ProjectRemoteGit = (args: string[], cwd: string) => Promise<string>

type ProjectRemoteOptions = Omit<Parameters<typeof localOnlyProjection>[0], "label"> & {
  git: ProjectRemoteGit
  isDirectory?: (directory: string) => Promise<boolean>
}

export type ProjectRemoteResult =
  | { kind: "origin"; remote: DerivedRemote; remotes: DerivedRemote[] }
  | { kind: "ambiguous"; remotes: DerivedRemote[] }
  | { kind: "no_remote" }
  | { kind: "not_a_repo" }
  | { kind: "git_timeout" }

export async function projectRemote(input: {
  directory: string
  git: ProjectRemoteGit
  isDirectory?: (directory: string) => Promise<boolean>
}): Promise<ProjectRemoteResult> {
  if (input.isDirectory && !(await input.isDirectory(input.directory))) return { kind: "not_a_repo" }
  // `--show-toplevel` separates "not a repository" from "a repository with no
  // remotes": both make `git remote -v` print nothing, and they need different
  // copy. `optionalGit` answers "" for the former and rethrows on timeout.
  const toplevel = await input.git(["rev-parse", "--show-toplevel"], input.directory)
  if (!toplevel.trim()) return { kind: "not_a_repo" }
  return deriveRemote(parseRemotes(await input.git(["remote", "-v"], input.directory)))
}

export function ProjectRemoteRoutes(options: ProjectRemoteOptions) {
  const { git, isDirectory, ...auth } = options
  const app = new Hono()
  app.use("/remote", localOnlyProjection({ ...auth, label: "ProjectRemote" }))
  app.get("/remote", async (c) => {
    const parsed = query.safeParse({ directory: c.req.query("directory") })
    if (!parsed.success) {
      return c.json(errorBody("project_directory_required", "A project directory is required"), 400)
    }
    const directory = parsed.data.directory
    // The path is never interpolated into a shell (the git runner takes an
    // args array), so this rejects a caller mistake rather than an injection:
    // a relative path would silently resolve against the server's cwd and
    // derive a remote for a folder the user never picked.
    if (!path.isAbsolute(directory)) {
      return c.json(errorBody("project_directory_not_absolute", "The project directory must be an absolute path"), 400)
    }
    try {
      return c.json(await projectRemote({ directory: path.normalize(directory), git, ...(isDirectory ? { isDirectory } : {}) }))
    } catch (err) {
      if ((err as Error)?.name === "GitTimeoutError") return c.json({ kind: "git_timeout" })
      throw err
    }
  })
  return app
}
