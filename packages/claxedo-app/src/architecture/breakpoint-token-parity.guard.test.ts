import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  BP_2XL,
  BP_EDITOR_COMPACT,
  BP_EDITOR_WIDE,
  BP_LG,
  BP_MD,
  BP_SM,
  BP_XL,
  BP_XS,
} from "../ui/controls/breakpoints"

// This guard is the weld between the breakpoint TS constants
// (src/ui/controls/breakpoints.ts) and the pixel literals scattered across CSS
// `@media` rules and JS/TS viewport gates. CSS custom properties CANNOT be
// interpolated into `@media` conditions, so those literals can never import the
// token — this source-text guard is the ONLY thing that catches a future edit
// changing BP_MD in TS without updating the `767`/`768` literals in
// app-shell.css / page-editor.css / renderer.ts / review-tab.tsx, etc. (WP-C3,
// inventory §5.4). Same intent as the i18n locale-parity manifest test (WP-A6).

const SRC_ROOT = path.resolve(import.meta.dir, "..")
const read = (rel: string): string => readFileSync(path.join(SRC_ROOT, rel), "utf8")

// Strip `/* … */` and `// …` comments so a literal cited in an explanatory
// comment (e.g. "preserves the original `<= 767`") does not read as a live gate.
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

describe("breakpoint token parity: app-shell.css :root custom properties vs TS constants", () => {
  test("every --bp-* custom property equals its src/ui/controls/breakpoints.ts constant", () => {
    const css = read("app/styles/app-shell.css")
    const declared: Record<string, number> = {}
    for (const m of css.matchAll(/--bp-([\w-]+):\s*(\d+)px/g)) {
      declared[m[1]] = Number(m[2])
    }
    expect(declared).toEqual({
      sm: BP_SM,
      md: BP_MD,
      lg: BP_LG,
      xl: BP_XL,
      "2xl": BP_2XL,
      "editor-wide": BP_EDITOR_WIDE,
      "editor-compact": BP_EDITOR_COMPACT,
      xs: BP_XS,
    })
  })
})

describe("breakpoint token parity: CSS @media literals stay welded to the tokens", () => {
  // The `@media` literal must equal the token; each entry is [file, mediaCondition].
  const cases: Array<[file: string, condition: string]> = [
    // app-shell.css — max-width complements sit one below the token.
    ["app/styles/app-shell.css", `@media (max-width: ${BP_MD - 1}px), (pointer: coarse)`],
    ["app/styles/app-shell.css", `@media (max-width: ${BP_MD - 1}px)`],
    ["app/styles/app-shell.css", `@media (max-width: ${BP_SM - 1}px)`],
    // ui-overrides.css — min-width equals the token exactly.
    ["app/styles/ui-overrides.css", `@media (min-width: ${BP_MD}px)`],
    ["app/styles/ui-overrides.css", `@media (min-width: ${BP_2XL}px)`],
  ]

  for (const [file, condition] of cases) {
    test(`${file} contains "${condition}"`, () => {
      expect(read(file)).toContain(condition)
    })
  }
})

describe("breakpoint token parity: JS/TS viewport gates reference the token, not a bare literal", () => {
  // Each migrated site must import + use the named constant and carry NO bare
  // flagged viewport literal in a comparison. The `\b<value>\b` check would also
  // catch a comment, so we only forbid the comparison forms (`< 640`, `<= 767`).
  const cases: Array<{ file: string; token: string; forbidden: RegExp[] }> = [
    {
      file: "features/terminal/core/backend/renderer.ts",
      token: "BP_MD",
      forbidden: [/<=?\s*767\b/],
    },
    {
      file: "app/dialogs/settings.tsx",
      token: "BP_SM",
      forbidden: [/<\s*640\b/],
    },
    {
      file: "features/workspaces/ui/panel/workspace-panel.tsx",
      token: "BP_SM",
      forbidden: [/<\s*640\b/],
    },
    {
      file: "features/review/ui/review-tab.tsx",
      token: "BP_MD",
      forbidden: [/<\s*768\b/],
    },
  ]

  for (const { file, token, forbidden } of cases) {
    test(`${file} uses ${token} and imports it from @/ui/controls/breakpoints`, () => {
      const text = read(file)
      expect(text).toContain(token)
      expect(text).toMatch(/from "@\/ui\/controls\/breakpoints"/)
    })

    test(`${file} has no bare viewport literal left in a comparison`, () => {
      const code = stripComments(read(file))
      for (const pattern of forbidden) {
        expect(code).not.toMatch(pattern)
      }
    })
  }
})

describe("breakpoint token parity: the workbench's duplicate BP_MD is welded", () => {
  // C3a defines its own `export const BP_MD = 768` in
  // app/workbench/workbench/collapse-projection.ts (workbench/** is owned by a
  // sibling worker, so it is not migrated to import from here). Weld the two
  // definitions so they cannot silently diverge; the follow-up is to have that
  // module re-export from src/ui/controls/breakpoints.ts.
  test("collapse-projection.ts's BP_MD literal equals src/ui/controls/breakpoints.ts BP_MD", () => {
    const text = read("app/workbench/workbench/collapse-projection.ts")
    const m = text.match(/export const BP_MD\s*=\s*(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(BP_MD)
  })
})
