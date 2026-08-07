import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { walk, type SourceFile } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")
const uiRoot = path.resolve(appRoot, "../ui")
const uiOverridesPath = path.join(appRoot, "src/app/styles/ui-overrides.css")
const migratedTokens = [
  "--codex-elevation-card",
  "--codex-elevation-stroke",
  "--codex-radius-overlay",
  "--codex-shadow-hairline",
  "--codex-shadow-overlay",
  "--codex-shadow-raised",
  "--codex-shadow-sidebar-edge",
] as const

describe("Codex theme architecture", () => {
  test("recognizes a reintroduced migrated-token definition", () => {
    expect(migratedTokenDefinitions([
      { path: "bad.css", text: ":root { --codex-shadow-overlay: 0 0 #0000; }" },
    ])).toEqual(["bad.css: --codex-shadow-overlay"])
  })

  test("keeps migrated semantic tokens out of every stylesheet", () => {
    const files = [path.join(appRoot, "src"), path.join(uiRoot, "src")]
      .flatMap(walk)
      .filter((file) => file.endsWith(".css"))
      .map((file) => ({ path: path.relative(path.resolve(appRoot, "../.."), file), text: readFileSync(file, "utf8") }))

    expect(migratedTokenDefinitions(files)).toEqual([])
  })

  test("recognizes forbidden declaration overrides", () => {
    expect(forbiddenImportantDeclarations(".bad { box-shadow: none !important; color: red !important; }")).toEqual([
      "box-shadow: none !important",
      "color: red !important",
    ])
  })

  test("keeps paint and geometry declarations out of the specificity escape hatch", () => {
    const css = readFileSync(uiOverridesPath, "utf8")

    expect(forbiddenImportantDeclarations(css)).toEqual([])
    expect(css.match(/!important/g)?.length ?? 0).toBeLessThanOrEqual(7)
  })

  test("recognizes a missing component consumer", () => {
    expect(missingConsumers({ "--surface-overlay-radius": ["border-radius: var(--radius-md)"] })).toEqual([
      "--surface-overlay-radius",
    ])
  })

  test("keeps every Codex geometry input connected to its component declaration", () => {
    const root = readFileSync(uiOverridesPath, "utf8")
    const consumers = {
      "--surface-overlay-radius": [
        read("../ui/src/components/dialog.css"),
        read("../ui/src/components/dropdown-menu.css"),
        read("../ui/src/components/context-menu.css"),
        read("../ui/src/components/popover.css"),
        read("../ui/src/components/select.css"),
        read("../ui/src/components/tooltip.css"),
        read("../ui/src/v2/components/menu-v2.css"),
        read("../ui/src/v2/components/select-v2.css"),
        read("../ui/src/v2/components/tooltip-v2.css"),
      ],
      "--surface-overlay-border": [
        read("../ui/src/components/dialog.css"),
        read("../ui/src/components/dropdown-menu.css"),
        read("../ui/src/components/context-menu.css"),
        read("../ui/src/components/popover.css"),
        read("../ui/src/components/select.css"),
        read("../ui/src/components/tooltip.css"),
      ],
      "--surface-overlay-shadow": [
        read("../ui/src/components/dialog.css"),
        read("../ui/src/components/dropdown-menu.css"),
        read("../ui/src/components/context-menu.css"),
        read("../ui/src/components/popover.css"),
        read("../ui/src/components/select.css"),
        read("../ui/src/components/tooltip.css"),
        read("../ui/src/v2/components/menu-v2.css"),
        read("../ui/src/v2/components/select-v2.css"),
        read("../ui/src/v2/components/tooltip-v2.css"),
      ],
      "--surface-card-radius": [read("src/ui/context-card/context-card.css"), read("src/app/styles/index.css")],
      "--surface-card-border": [read("src/ui/context-card/context-card.css"), read("src/app/styles/index.css")],
      "--surface-card-shadow": [read("src/ui/context-card/context-card.css"), read("src/app/styles/index.css")],
      "--surface-composer-shadow": [read("../ui/src/components/dock-surface.css")],
      "--surface-sidebar-shadow": [root],
    }

    expect(Object.keys(consumers).filter((token) => !root.includes(`${token}:`))).toEqual([])
    expect(missingConsumers(consumers)).toEqual([])
  })

  test("retires theme-specific call-site escape hatches", () => {
    const files = [path.join(appRoot, "src"), path.join(uiRoot, "src")]
      .flatMap(walk)
      .filter((file) => /\.(?:css|tsx?)$/.test(file))
      .filter((file) => file !== import.meta.path)

    const retired = [
      "codex-directory-picker",
      "codex-overlay-surface",
      "claxedo-command-palette",
      "claxedo-settings-dialog",
    ]
    expect(files.flatMap((file) => retired.filter((name) => readFileSync(file, "utf8").includes(name))
      .map((name) => `${path.relative(appRoot, file)}: ${name}`))).toEqual([])
  })
})

function read(relative: string) {
  return readFileSync(path.resolve(appRoot, relative), "utf8")
}

function forbiddenImportantDeclarations(css: string) {
  return Array.from(css.matchAll(/\b(?:box-shadow|border(?:-[a-z-]+)?|border-radius|background(?:-[a-z-]+)?|color|font(?:-[a-z-]+)?)\s*:[^;{}]*!important/gi), (match) => match[0])
}

function missingConsumers(consumers: Record<string, string[]>) {
  return Object.entries(consumers)
    .filter(([token, files]) => files.some((css) => !new RegExp(`var\\(\\s*${token}`).test(css)))
    .map(([token]) => token)
}

function migratedTokenDefinitions(files: SourceFile[]) {
  return files.flatMap((file) => migratedTokens
    .filter((token) => new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(file.text))
    .map((token) => `${file.path}: ${token}`))
}
