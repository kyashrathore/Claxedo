import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")
const baseline = JSON.parse(readFileSync(path.join(import.meta.dir, "layout-guard-baseline.json"), "utf8")) as {
  entrypointHosts: string[]
  layoutLazyImports: string[]
  pagesLayoutImports: string[]
  claxedoLayoutContextImports: string[]
  railLayoutInnerMounts: string[]
  heavyShowWrappedPanels: string[]
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") return []
      return listSourceFiles(file)
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) return []
    return [file]
  })
}

function relative(file: string) {
  return canonicalRelativePath(path.relative(srcRoot, file))
}

function canonicalRelativePath(value: string) {
  return value.replaceAll("\\", "/")
}

function productionSourceFiles() {
  return listSourceFiles(srcRoot).filter((file) => {
    const name = relative(file)
    if (name.startsWith("architecture/")) return false
    return !/\.(test|vitest)\.tsx?$/.test(name)
  })
}

function importSpecifiers(text: string) {
  return [...text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  )
}

function scanImportSpecifiers(match: (file: string, specifier: string) => boolean) {
  return productionSourceFiles()
    .flatMap((file) =>
      importSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => match(file, specifier))
        .map((specifier) => `${relative(file)}:${specifier}`),
    )
    .sort()
}

// The shell rewrite replaced the <ClaxedoAppShellHost> JSX mount with a
// signal-driven load: runtime-providers dynamic-imports @/app/app-shell-bootstrap,
// which lazy()-imports ./app-shell. "One shell layout entrypoint" now means
// exactly one import edge at each of those two seams.
function scanEntrypointHosts() {
  return scanImportSpecifiers((_file, specifier) => specifier === "@/app/app-shell-bootstrap")
}

function scanLayoutLazyImports() {
  return scanImportSpecifiers(
    (file, specifier) =>
      specifier === "@/app/app-shell" || (specifier === "./app-shell" && relative(file).startsWith("app/")),
  )
}

function scanPagesLayoutImports() {
  return scanImportSpecifiers(isPagesLayoutImport)
}

function scanClaxedoLayoutContextImports() {
  return scanImportSpecifiers((_file, specifier) => /(?:^|\/)context\/claxedo-layout(?:\/|$)/.test(specifier))
}

function isPagesLayoutImport(file: string, specifier: string) {
  if (specifier === "@/app/routes/layout" || specifier.startsWith("@/app/routes/layout/")) return true
  if (!specifier.startsWith(".")) return false
  const target = path.resolve(path.dirname(file), specifier)
  const pagesLayoutRoot = path.join(srcRoot, "app/routes/layout")
  return target === pagesLayoutRoot || target.startsWith(`${pagesLayoutRoot}${path.sep}`)
}

function scanRailLayoutInnerMounts() {
  return productionSourceFiles()
    .flatMap((file) => {
      const text = readFileSync(file, "utf8")
      return [...text.matchAll(/<RailLayoutInner\b/g)].map(() => `${relative(file)}:RailLayoutInner`)
    })
    .sort()
}

function scanHeavyShowWrappedPanelsInText(file: string, text: string) {
  return ["ReviewWorkspace", "Workbench", "WorkspacePanel", "RailSidebar", "TerminalView"].flatMap((name) => {
    const pattern = new RegExp(`<Show[\\s\\S]{0,400}<${name}\\b`, "g")
    return [...text.matchAll(pattern)].map(() => `${file}:${name}`)
  })
}

function scanHeavyShowWrappedPanels() {
  return productionSourceFiles()
    .flatMap((file) => scanHeavyShowWrappedPanelsInText(relative(file), readFileSync(file, "utf8")))
    .sort()
}

function expectPinned(name: keyof typeof baseline, actual: string[]) {
  expect(
    actual,
    `${name} changed. If this decreased, prune layout-guard-baseline.json in the same commit; if it increased, do not add a second layout path.`,
  ).toEqual([...baseline[name]].sort())
}

describe("layout architecture guard", () => {
  test("keeps exactly one shell layout entrypoint", () => {
    expectPinned("entrypointHosts", scanEntrypointHosts())
    expectPinned("layoutLazyImports", scanLayoutLazyImports())
    expect(scanEntrypointHosts()).toHaveLength(1)
    expect(scanLayoutLazyImports()).toHaveLength(1)
  })

  test("keeps legacy layout imports pinned and shrinking", () => {
    expectPinned("pagesLayoutImports", scanPagesLayoutImports())
    expectPinned("claxedoLayoutContextImports", scanClaxedoLayoutContextImports())
    expectPinned("railLayoutInnerMounts", scanRailLayoutInnerMounts())
  })

  test("keeps heavy panels out of Show toggles", () => {
    expectPinned("heavyShowWrappedPanels", scanHeavyShowWrappedPanels())
  })

  test("scanner catches fixture violations", () => {
    expect(canonicalRelativePath("app\\entry\\runtime-providers.tsx")).toBe("app/entry/runtime-providers.tsx")
    expect(canonicalRelativePath("app/entry/runtime-providers.tsx")).toBe("app/entry/runtime-providers.tsx")
    expect(importSpecifiers('import { Layout } from "@/app/routes/layout"')).toEqual(["@/app/routes/layout"])
    expect(importSpecifiers('import { useClaxedoLayout } from "../context/claxedo-layout"')).toEqual([
      "../context/claxedo-layout",
    ])
    expect(
      isPagesLayoutImport(path.join(srcRoot, "app/workbench/titlebar/titlebar.tsx"), "@/app/routes/layout/fixture"),
    ).toBe(true)
    expect(
      isPagesLayoutImport(
        path.join(srcRoot, "app/workbench/rail/rail-sidebar.tsx"),
        "../../routes/layout/prefetch-policy",
      ),
    ).toBe(true)
    expect(
      isPagesLayoutImport(path.join(srcRoot, "features/session/ui/session-screen.tsx"), "./session/session-layout"),
    ).toBe(false)
    expect(scanHeavyShowWrappedPanelsInText("fixture.tsx", "<Show when={open()}><WorkspacePanel /></Show>")).toEqual([
      "fixture.tsx:WorkspacePanel",
    ])
  })
})
