/**
 * Values more than one policy needs, declared once.
 *
 * Kept deliberately small. A policy is supposed to be readable top-to-bottom as
 * "what this product may reach"; hoisting its lists into a shared file to save
 * a few lines is how one product silently inherits another's exceptions.
 * Only genuinely shared FACTS live here — how this repository's build tools
 * resolve a specifier, which is not a per-product opinion.
 */

import type { Alias } from "../closure.ts"

/**
 * The `@/` alias, plus the one virtual module the app resolves by build config.
 *
 * `vite.cloud.config.ts` maps `@/` onto `claxedo-app/src`, and
 * `claxedo-desktop/vite.renderer.ts` maps the SAME prefix onto the same
 * directory for the Electron renderer — which is why the desktop policies below
 * carry it too. Nothing resolves `@/` from a package manifest, so a walk
 * without this list answers "unresolved" for every app module and reports a
 * clean product it never opened.
 *
 * `#terminal-backend` is chosen by the desktop config between an xterm and an
 * OpenTUI backend. Both live under `features/terminal/core/backend/`, and
 * neither reaches anything the boundary rules name, so the walk pins the xterm
 * one rather than pretending a build-time choice is a graph fork.
 */
export const APP_ALIASES: Alias[] = [
  { prefix: "@", target: "packages/claxedo-app/src" },
  { prefix: "#terminal-backend", target: "packages/claxedo-app/src/features/terminal/core/backend/xterm.ts" },
]

/**
 * `import pkg from "../../package.json"` — a version read, in two shells.
 *
 * Declared rather than filtered by extension: the point of the outside-roots
 * report is that a first-party file reached across a root boundary gets named,
 * and "it was JSON" is not a reason to stop naming it.
 */
export const MANIFEST_READS = [
  "packages/claxedo-app/src/app/dialogs/settings.tsx -> packages/claxedo-app/package.json",
  "packages/claxedo-desktop/src/renderer/shell.tsx -> packages/claxedo-desktop/package.json",
]

/**
 * Tasks, as the emitted artifact shows it.
 *
 * `CLAXEDO_BUILD_TASKS=0` is read here, once, for every policy that has to
 * state a different emitted cut for the two builds. Each product's gate is a
 * value its bundler replaces, so the SOURCE walk reaches Tasks either way and
 * only the emitted half can tell the artifacts apart.
 *
 * The marker is the chunk name Rollup derives from the module behind the gated
 * dynamic import (`app/integrations/tasks-contributions.ts`). It is asserted
 * PRESENT on an enabled build as well as absent on a disabled one: a forbidden
 * marker alone passes when a rename makes the name unfindable in both.
 */
export const TASKS_CHUNK_MARKER = "tasks-contributions"

export const TASKS_SELECTED = process.env.CLAXEDO_BUILD_TASKS !== "0"

export function tasksModuleRoots(appSrc: string) {
  return [
    "packages/claxedo-tasks",
    `${appSrc}/app/integrations/tasks`,
    `${appSrc}/app/integrations/tasks-contributions.ts`,
    `${appSrc}/features/tasks`,
  ]
}
