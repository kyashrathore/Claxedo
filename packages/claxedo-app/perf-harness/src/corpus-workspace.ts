export type MaterializedWorkspace = { directory: string; projectId: string }

export async function initializeWorkspace(directory: string, workspaceId: string) {
  await runGit(["init", "--initial-branch=main", directory])
  await runGit(
    [
      "-C",
      directory,
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      workspaceId ? `Agent app benchmark corpus ${workspaceId}` : "Agent app benchmark corpus",
    ],
    {
      GIT_AUTHOR_NAME: "Agent App Benchmark",
      GIT_AUTHOR_EMAIL: "benchmark@localhost",
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Agent App Benchmark",
      GIT_COMMITTER_EMAIL: "benchmark@localhost",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    },
  )
  const projectId = (await runGit(["-C", directory, "rev-list", "--max-parents=0", "HEAD"])).trim()
  if (!/^[0-9a-f]{40}$/u.test(projectId)) throw new Error("Claxedo did not create a canonical workspace project id")
  return projectId
}

async function runGit(args: string[], env?: Record<string, string>) {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    env: env ? { ...process.env, ...env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`Claxedo workspace preparation failed: ${(stderr || stdout).trim()}`)
  return stdout
}
