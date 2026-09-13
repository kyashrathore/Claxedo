import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { importSpecifiers, resolveImport, stripComments } from "./import-graph"
import { prodSourcePaths } from "./scanners"
import { CONTENT_TYPES } from "../app/workbench/state/types"

const appRoot = path.resolve(import.meta.dir, "../..")

/**
 * What a `CLAXEDO_BUILD_TASKS=0` renderer can still reach.
 *
 * The gate is a `define`d identifier, so the SOURCE graph reaches Tasks in both
 * builds and no walk can be asked "is Tasks in this artifact". What decides the
 * answer is whether EVERY route into Tasks goes through the one module the gate
 * dynamic-imports: a single other edge — static or dynamic, from any production
 * module — puts `@claxedo/tasks`, `features/tasks/**` and
 * `app/integrations/tasks/**` back into every artifact with the define still
 * present and reading correct.
 *
 * So this scans the whole production source set rather than walking from an
 * entry. An entry walk answers a narrower question and answers it misleadingly
 * here: `secondary-feature-ports.ts` is itself reached only dynamically, so a
 * static-only walk from `local.tsx` never opens the file that holds the gate
 * and reports a clean product whatever that file says.
 *
 * The emitted half is `script/product-boundary/policies/app-local.ts`, whose
 * `requiredChunkMarkers`/`forbiddenChunkMarkers` pair is checked against a real
 * build by `verify:closure`. A green result here means the source routes Tasks
 * through the gate, nothing more.
 */
const TASKS_ROOTS = ["app/integrations/tasks/", "features/tasks/"]
const TASKS_PACKAGE = "@claxedo/tasks"
const GATE = "app/integrations/secondary-feature-ports.ts"
const GATED_MODULE = "app/integrations/tasks-contributions.ts"

function underTasks(module: string) {
  return TASKS_ROOTS.some((root) => module.startsWith(root))
}

/**
 * Value imports only: `import type` is erased whole, so a type edge onto a
 * Tasks contract puts nothing in the artifact.
 */
function tasksEdges() {
  const srcRoot = path.join(appRoot, "src")
  const edges: string[] = []
  for (const file of prodSourcePaths(appRoot)) {
    const from = path.relative(srcRoot, file).split(path.sep).join("/")
    if (underTasks(from) || from === GATED_MODULE) continue
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier === TASKS_PACKAGE || specifier.startsWith(`${TASKS_PACKAGE}/`)) {
        edges.push(`${from} -> ${specifier}`)
        continue
      }
      const resolved = resolveImport(appRoot, file, specifier)
      if (!resolved) continue
      const to = path.relative(srcRoot, resolved).split(path.sep).join("/")
      if (underTasks(to) || to === GATED_MODULE) edges.push(`${from} -> ${to}`)
    }
  }
  return edges
}

function read(relative: string) {
  return readFileSync(path.join(appRoot, relative), "utf8")
}

async function defineFor(
  loadConfig: () => Promise<Record<string, unknown> | undefined>,
  selection: string | undefined,
) {
  const previous = process.env.CLAXEDO_BUILD_TASKS
  const previousAdapter = process.env.VITE_CLAXEDO_AUTH_ADAPTER
  if (selection === undefined) delete process.env.CLAXEDO_BUILD_TASKS
  else process.env.CLAXEDO_BUILD_TASKS = selection
  // The config refuses to compose without an explicit browser-auth selection,
  // which is a different switch and has to be supplied for either Tasks value.
  process.env.VITE_CLAXEDO_AUTH_ADAPTER ??= "better-auth"
  try {
    const config = await loadConfig()
    return (config?.define as Record<string, unknown> | undefined)?.__CLAXEDO_TASKS_ENABLED__
  } finally {
    if (previous === undefined) delete process.env.CLAXEDO_BUILD_TASKS
    else process.env.CLAXEDO_BUILD_TASKS = previous
    if (previousAdapter === undefined) delete process.env.VITE_CLAXEDO_AUTH_ADAPTER
    else process.env.VITE_CLAXEDO_AUTH_ADAPTER = previousAdapter
  }
}

/**
 * The config factories are re-imported per selection on purpose.
 *
 * Both read `process.env` when they run, not when they are imported, so one
 * module instance answers for every selection — but a cached module that
 * captured the variable at import time would make every case below agree with
 * the first one and the switch would read as working.
 */
async function cloudDefine(selection: string | undefined) {
  return defineFor(async () => {
    const module = await import(`../../vite.cloud.config?tasks=${selection ?? "unset"}`)
    return (module.default as (env: { command: string; mode: string }) => Record<string, unknown>)({
      command: "build",
      mode: "production",
    })
  }, selection)
}

async function localDefine(selection: string | undefined) {
  return defineFor(async () => {
    const module = await import(`../../vite.local.config?tasks=${selection ?? "unset"}`)
    return (module.default as (env: { command: string; mode: string }) => Record<string, unknown>)({
      command: "build",
      mode: "production",
    })
  }, selection)
}

describe("the Tasks build selection", () => {
  test("the gate owns the only edge into Tasks in the whole production source set", () => {
    expect(tasksEdges()).toEqual([`${GATE} -> ${GATED_MODULE}`])
  })

  test("the scan reads this package, so an empty edge list is an answer", () => {
    // Without this an exclusion bug that dropped every file would satisfy the
    // assertion above and report the cut as clean.
    expect(prodSourcePaths(appRoot).length).toBeGreaterThan(900)
  })

  test("the gate is a string literal under the defined identifier", () => {
    const source = stripComments(read("src/app/integrations/secondary-feature-ports.ts"))
    // An `import(variable)` here would be invisible to this walk, to the
    // typechecker and to the product-boundary walker, which reports an opaque
    // import as a broken measurement rather than a clean product.
    expect(source).toContain('__CLAXEDO_TASKS_ENABLED__\n  ? import("@/app/integrations/tasks-contributions")')
    expect(source).not.toContain("tasks-ports")
  })

  test("the gated module is the only place the ports and the surface are registered", () => {
    const contributions = stripComments(read("src/app/integrations/tasks-contributions.ts"))
    expect(contributions).toContain("configureTasksAppPorts(tasksAppPorts())")
    expect(contributions).toContain("registerContentSurface(tasksContentSurface)")
    expect(contributions).toContain("registerSettingsSection(tasksPresetsSettingsSection)")
  })

  test("the sidebar row and the /tasks intent are gated by the same identifier", () => {
    expect(stripComments(read("src/app/app-shell.tsx"))).toContain(
      "onOpenTasks={__CLAXEDO_TASKS_ENABLED__ ? handleOpenTasks : undefined}",
    )
    expect(stripComments(read("src/app/workbench/state/route-bridge.tsx"))).toContain(
      'tasks: __CLAXEDO_TASKS_ENABLED__ && routeKind === "tasks"',
    )
  })

  test("the tasks content type stays declared whatever the selection is", () => {
    // Restored-tab validation runs before any dynamic import resolves, and a
    // type it does not recognize is a tab it deletes. An off build must leave
    // the user's Tasks tabs alone, not reap them.
    expect(CONTENT_TYPES).toContain("tasks")
  })

  test("only an explicit 0 turns Tasks off, in both renderer builds", async () => {
    expect(await cloudDefine(undefined)).toBe("true")
    expect(await cloudDefine("1")).toBe("true")
    expect(await cloudDefine("0")).toBe("false")
    // The local config derives from the cloud one rather than restating it, so
    // the define reaching it is a property of that derivation, not a copy.
    expect(await localDefine(undefined)).toBe("true")
    expect(await localDefine("0")).toBe("false")
  })
})
