import type { Hono } from "hono"
import { runGit } from "../git"
import { currentSessionCore } from "../session-context"

function requestDirectory(c: { req: { query(name: string): string | undefined } }) {
  return currentSessionCore().placement.resolveDirectory(c.req.query("directory"))
}

export function mountWorkspaceVcs(app: Hono) {
  app.get("/vcs", async (c) => c.json(await localVcsInfo(requestDirectory(c))))
}

async function localVcsInfo(directory: string) {
  const gitLine = async (args: string[]) => {
    try {
      return (await runGit(args, directory)).trim() || undefined
    } catch {
      return undefined
    }
  }
  const [branch, remoteHead] = await Promise.all([
    gitLine(["branch", "--show-current"]),
    gitLine(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
  ])
  return {
    ...(branch ? { branch } : {}),
    ...(remoteHead ? { default_branch: remoteHead.replace(/^origin\//, "") } : {}),
  }
}
