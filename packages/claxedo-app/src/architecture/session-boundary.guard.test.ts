import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  newSessionBoundaryViolations,
  sessionBoundaryKey,
  sessionBoundaryViolationKeys,
  sessionBoundaryViolationsFromFiles,
  staleSessionBoundaryViolations,
} from "./session-boundary"
import baseline from "./session-boundary-baseline.json"

const appRoot = path.resolve(import.meta.dir, "../..")

describe("session-client boundary guard", () => {
  test("does not introduce a new session/** import into pane/shell/claxedo-ui/context beyond the baseline", () => {
    const offenders = newSessionBoundaryViolations(sessionBoundaryViolationKeys(appRoot), baseline).map(
      (key) => `${key}: session-client layer must not import shell chrome -- invert the dependency or move the seam`,
    )

    expect(offenders).toEqual([])
  })

  test("keeps the session-boundary baseline pruned as offenders are untangled", () => {
    const offenders = staleSessionBoundaryViolations(sessionBoundaryViolationKeys(appRoot), baseline).map(
      (key) => `${key}: no longer crosses the boundary -- remove it from session-boundary-baseline.json`,
    )

    expect(offenders).toEqual([])
  })
})

describe("session-client boundary guard (synthetic detection)", () => {
  test("flags a session/** import that resolves into a forbidden directory", () => {
    const files = [{ path: "session/store/a.ts", text: `import { x } from "@/shell/data/keys"` }]
    const resolve = (fromRelFile: string, specifier: string) =>
      fromRelFile === "session/store/a.ts" && specifier === "@/shell/data/keys" ? "shell/data/keys.ts" : null

    expect(sessionBoundaryViolationsFromFiles(files, resolve).map(sessionBoundaryKey)).toEqual([
      "session/store/a.ts -> shell/data/keys.ts",
    ])
  })

  test("ignores session-internal imports and imports into non-forbidden directories", () => {
    const files = [
      { path: "session/store/a.ts", text: `import { b } from "./b"\nimport { u } from "@/utils/api"` },
    ]
    const resolve = (fromRelFile: string, specifier: string) => {
      if (specifier === "./b") return "session/store/b.ts"
      if (specifier === "@/utils/api") return "utils/api.ts"
      return null
    }

    expect(sessionBoundaryViolationsFromFiles(files, resolve)).toEqual([])
  })

  test("ignores imports FROM non-session files even into forbidden directories", () => {
    const files = [{ path: "shell/data/keys.ts", text: `import { p } from "@/context/prompt"` }]
    const resolve = () => "context/prompt.tsx"

    expect(sessionBoundaryViolationsFromFiles(files, resolve)).toEqual([])
  })

  test("keys on the resolved target, not the raw specifier, so an @/ <-> relative rewrite does not churn the baseline", () => {
    const viaAlias = sessionBoundaryViolationsFromFiles(
      [{ path: "session/store/a.ts", text: `import { x } from "@/shell/data/keys"` }],
      () => "shell/data/keys.ts",
    ).map(sessionBoundaryKey)
    const viaRelative = sessionBoundaryViolationsFromFiles(
      [{ path: "session/store/a.ts", text: `import { x } from "../../shell/data/keys"` }],
      () => "shell/data/keys.ts",
    ).map(sessionBoundaryKey)

    expect(viaAlias).toEqual(viaRelative)
  })

  test("newSessionBoundaryViolations fails on a violation absent from the baseline", () => {
    expect(newSessionBoundaryViolations(["session/x.ts -> shell/y.ts"], [])).toEqual(["session/x.ts -> shell/y.ts"])
    expect(newSessionBoundaryViolations(["session/x.ts -> shell/y.ts"], ["session/x.ts -> shell/y.ts"])).toEqual([])
  })

  test("staleSessionBoundaryViolations demands pruning once an offender is resolved", () => {
    expect(staleSessionBoundaryViolations([], ["session/x.ts -> shell/y.ts"])).toEqual(["session/x.ts -> shell/y.ts"])
    expect(staleSessionBoundaryViolations(["session/x.ts -> shell/y.ts"], ["session/x.ts -> shell/y.ts"])).toEqual([])
  })
})
