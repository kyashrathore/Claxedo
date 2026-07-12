import { describe, expect, test } from "bun:test"
import {
  dependencyViolation,
  logicalCyclesFromEdges,
  logicalImportEdgesFromFiles,
  logicalOwner,
  malformedAliasSpecifiers,
  migrationManifestViolations,
  type MigrationManifest,
} from "./ownership"

describe("logical ownership", () => {
  test("resolves final roots at the boundary depth they enforce", () => {
    expect(logicalOwner("app/routes/session.tsx")).toBe("app")
    expect(logicalOwner("features/session/ui/timeline.tsx")).toBe("features/session")
    expect(logicalOwner("features/terminal/core/stream.ts")).toBe("features/terminal")
    expect(logicalOwner("platform/query/client.ts")).toBe("platform/query")
    expect(logicalOwner("ui/dialogs/confirm.tsx")).toBe("ui")
    expect(logicalOwner("lib/path.ts")).toBe("lib")
    expect(logicalOwner("architecture/scanners.ts")).toBe("architecture")
  })

  test("classifies legacy directories separately and leaves root declarations unowned", () => {
    expect(logicalOwner("shell/boot/data/bootstrap.ts")).toBe("legacy/shell")
    expect(logicalOwner("context/global-sync.tsx")).toBe("legacy/context")
    expect(logicalOwner("app.tsx")).toBe("legacy/root")
    expect(logicalOwner("env.d.ts")).toBeNull()
  })

  test("enforces the final dependency direction", () => {
    expect(dependencyViolation("app", "features/session")).toBeUndefined()
    expect(dependencyViolation("features/session", "platform/query")).toBeUndefined()
    expect(dependencyViolation("features/session", "ui")).toBeUndefined()
    expect(dependencyViolation("platform/query", "lib")).toBeUndefined()
    expect(dependencyViolation("ui", "lib")).toBeUndefined()
    expect(dependencyViolation("features/session", "features/terminal")).toContain("feature-to-feature")
    expect(dependencyViolation("platform/auth", "platform/identity")).toBeUndefined()
    expect(dependencyViolation("platform/query", "features/session")).toContain("platform")
    expect(dependencyViolation("lib", "platform/query")).toContain("lib")
    expect(dependencyViolation("features/session", "legacy/shell")).toContain("legacy")
  })

  test("detects multi-capability cycles while allowing an acyclic platform graph", () => {
    expect(logicalCyclesFromEdges([
      { from: "platform/sync", to: "platform/query" },
      { from: "platform/query", to: "platform/api" },
    ])).toEqual([])
    expect(logicalCyclesFromEdges([
      { from: "platform/sync", to: "platform/query" },
      { from: "platform/query", to: "platform/api" },
      { from: "platform/api", to: "platform/sync" },
    ])).toEqual(["platform/api -> platform/sync -> platform/query -> platform/api"])
  })

  test("keeps legacy imports governed by the existing cycle ratchet during migration", () => {
    expect(dependencyViolation("legacy/context", "legacy/shell")).toBeUndefined()
    expect(dependencyViolation("legacy/context", "platform/query")).toBeUndefined()
  })

  test("extracts runtime logical edges from alias, relative, and lazy imports", () => {
    const files = [
      {
        path: "features/session/ui/screen.tsx",
        text: [
          `import { query } from "@/platform/query/client"`,
          `import type { Props } from "../../terminal/ui/props"`,
          `const lazy = import("@/ui/dialogs/confirm")`,
          `import { local } from "./local"`,
        ].join("\n"),
      },
    ]
    const targets: Record<string, string> = {
      "@/platform/query/client": "platform/query/client.ts",
      "../../terminal/ui/props": "features/terminal/ui/props.ts",
      "@/ui/dialogs/confirm": "ui/dialogs/confirm.tsx",
      "./local": "features/session/ui/local.ts",
    }

    expect(logicalImportEdgesFromFiles(files, (_, specifier) => targets[specifier] ?? null)).toEqual([
      {
        from: "features/session",
        to: "platform/query",
        file: "features/session/ui/screen.tsx",
        specifier: "@/platform/query/client",
      },
      {
        from: "features/session",
        to: "ui",
        file: "features/session/ui/screen.tsx",
        specifier: "@/ui/dialogs/confirm",
      },
    ])
  })

  test("flags aliases accidentally prefixed by relative path segments", () => {
    expect(malformedAliasSpecifiers([
      { path: "a.ts", text: `import { a } from "@/lib/a"` },
      { path: "b.ts", text: `import { b } from ".@/platform/query/query-client"` },
      { path: "c.ts", text: `const c = import("../../.@/features/session")` },
    ])).toEqual([
      { file: "b.ts", line: 1, match: ".@/" },
      { file: "c.ts", line: 1, match: "../../.@/" },
    ])
  })
})

describe("migration manifest", () => {
  const manifest: MigrationManifest = {
    version: 1,
    retiredRoots: [],
    entries: [
      {
        source: "browser/browser-pane.tsx",
        target: "features/browser/ui/browser-pane.tsx",
        owner: "features/browser",
        unit: 3,
      },
    ],
  }

  test("accepts complete live entries with matching target owners", () => {
    expect(migrationManifestViolations(["browser/browser-pane.tsx"], manifest)).toEqual([])
  })

  test("reports unclassified legacy files, stale entries, and owner mismatches", () => {
    expect(migrationManifestViolations(["browser/new-file.ts"], manifest)).toEqual([
      "browser/new-file.ts: legacy file is missing from migration-manifest.json",
      "browser/browser-pane.tsx: manifest source is missing from the live tree",
    ])

    expect(migrationManifestViolations(["browser/browser-pane.tsx"], {
      ...manifest,
      entries: [{ ...manifest.entries[0], owner: "features/session" }],
    })).toEqual([
      "browser/browser-pane.tsx: target features/browser/ui/browser-pane.tsx resolves to features/browser, not features/session",
    ])
  })

  test("rejects duplicate sources, duplicate targets, and live retired roots", () => {
    expect(migrationManifestViolations(["browser/browser-pane.tsx"], {
      version: 1,
      retiredRoots: ["browser"],
      entries: [manifest.entries[0], { ...manifest.entries[0] }],
    })).toEqual([
      "browser: retired legacy root still contains browser/browser-pane.tsx",
      "browser/browser-pane.tsx: duplicate manifest source",
      "features/browser/ui/browser-pane.tsx: duplicate manifest target",
    ])
  })

  test("keeps colocated tests with their production subject", () => {
    expect(migrationManifestViolations(["utils/breakpoints.ts", "utils/breakpoints.test.ts"], {
      version: 1,
      retiredRoots: [],
      entries: [
        { source: "utils/breakpoints.ts", target: "ui/controls/breakpoints.ts", owner: "ui", unit: 8 },
        { source: "utils/breakpoints.test.ts", target: "lib/breakpoints.test.ts", owner: "lib", unit: 2 },
      ],
    })).toContain("utils/breakpoints.test.ts: test owner lib differs from subject utils/breakpoints.ts owner ui")
  })
})
