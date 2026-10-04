import { CONTRACT_DIST, ensureWorkspaceDist, HELPERS_DIST, LAUNCH_GATE_CHILD_DIST } from "../../../harness/e2e/harness/workspace-dists"

export async function ensureLaunchGateChild(): Promise<{ built: boolean; ms: number }> {
  const started = Date.now()
  await ensureWorkspaceDist(HELPERS_DIST)
  await ensureWorkspaceDist(CONTRACT_DIST)
  const built = await ensureWorkspaceDist(LAUNCH_GATE_CHILD_DIST)
  return { built, ms: built ? Date.now() - started : 0 }
}
