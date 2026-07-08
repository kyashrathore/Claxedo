import type { AppTarget } from "./types"

// We measure exactly one thing: our app, in a real browser. No upstream target,
// no comparison, no manufactured deltas.
export const app = {
  id: "claxedo" as AppTarget,
  label: "Claxedo app",
  package_dir: "packages/claxedo-app",
  command: "bun --cwd packages/claxedo-app dev",
}

export function targetLabel(_target: AppTarget = "claxedo") {
  return app.label
}
