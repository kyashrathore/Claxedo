import { describe, expect, test } from "bun:test"

/*
 * Shared components must not name a theme. Every role below resolves for every
 * bundled theme (see SEMANTIC_THEME_ROLE_FALLBACKS in resolve.ts), so a
 * floating surface can ask for `--overlay-surface` instead of reaching for a
 * `--codex-*` escape hatch with a generic fallback baked in behind it.
 *
 * The rename was NOT free for every declaration, and c02ca9c21b's message
 * overstated it as "a rename and nothing more". That check compared each role
 * against its own fallback; it should have compared each role against the token
 * that actually sat in that declaration's fallback slot. Re-run per declaration
 * across the 74 non-Codex theme/mode pairs, four of the six move nothing —
 * content background, item label, item hover, and the muted group/disabled
 * text are all identical everywhere. Two moved:
 *
 *   separator `border-top-color`: `border-weak-base` -> `overlay-border`
 *     (= `border-base`), different in 74/74. Kept: the content border beside it
 *     is `overlay-border` too, so the separator was the odd one out.
 *   popover description: `text-base` -> `overlay-text-muted`, different in
 *     74/74. NOT kept — it put body copy under 4.5:1 in 21 themes. See the
 *     comment on that declaration in popover.css.
 */
const overlayFiles = [
  "../components/context-menu.css",
  "../components/dropdown-menu.css",
  "../components/popover.css",
  "../components/select.css",
]

/*
 * These are painted from their own design system's tokens rather than the
 * semantic roles, and Codex bridges them on the component root in
 * claxedo-app's `ui-overrides.css`. They still must not name a theme.
 *
 * v2 components: `--overlay-surface` falls back to a v1 token, so pointing a v2
 * surface at it would move every non-Codex theme off its v2 ramp.
 * toast/tooltip (v1): the app's chip is deliberately inverted for other themes;
 * only Codex opts out, and there is no semantic role for "inverted chip".
 */
const bridgedFiles = [
  "../components/toast.css",
  "../components/tooltip.css",
  "../v2/components/menu-v2.css",
  "../v2/components/select-v2.css",
  "../v2/components/toast-v2.css",
  "../v2/components/tooltip-v2.css",
]

const read = (file: string) => Bun.file(new URL(file, import.meta.url)).text()

describe("semantic overlay CSS", () => {
  test("overlay components paint from the generic overlay roles", async () => {
    for (const file of overlayFiles) {
      const css = await read(file)
      expect(css, file).toContain("var(--overlay-surface")
      expect(css, file).not.toContain("--codex-")
    }
  })

  test("bridged components name no theme either", async () => {
    for (const file of bridgedFiles) {
      expect(await read(file), file).not.toContain("--codex-")
    }
  })

  /*
   * Shape and elevation stay component-owned. The generic geometry inputs let
   * the application appearance layer select a scale, while each component's
   * previous declaration remains its fallback for every other theme.
   */
  test("keeps overlay shape and elevation component-owned", async () => {
    const legacy = await read("../components/dropdown-menu.css")
    const v2 = await read("../v2/components/menu-v2.css")

    expect(legacy).toContain("border-radius: var(--surface-overlay-radius, var(--radius-md))")
    expect(legacy).toContain("box-shadow: var(--surface-overlay-shadow, var(--shadow-md))")
    expect(v2).toContain("border-radius: var(--surface-overlay-radius, 6px)")
    expect(v2).toContain("box-shadow: var(--surface-overlay-shadow, var(--v2-elevation-floating))")
  })
})
