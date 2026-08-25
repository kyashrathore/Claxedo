import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The panel body's warm-up is only worth anything while three wiring facts
 * hold, and every one of them fails SILENTLY — the panel still opens, just
 * back at its unwarmed cost, with nothing in a type, a test double or a
 * runtime error to say so. Each is asserted on the real source text because
 * what is being protected is which module owns an edge, not a value the
 * running code exposes.
 *
 * Measured stake (perf-harness debug-review-construct-probe, 500-file corpus,
 * click-relative resource timings): unwarmed, the four panel chunks start only
 * when the shell settle gate opens construction near click+100ms and the open
 * path waits a further ~74ms for them.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const read = (file: string) => readFileSync(path.join(here, file), "utf8")

describe("workspace panel review warm-up wiring", () => {
  test("the panel body mounts the warmed lazy wrapper instead of one of its own", () => {
    const body = read("workspace-panel-body.tsx")
    // Solid's lazy() caches the resolved module on the WRAPPER, so a second
    // wrapper around the same specifier suspends on its own first render even
    // with the chunk already loaded — the warm-up would buy nothing.
    expect(body).toContain('import { ReviewWorkspace } from "./workspace-panel-review-load"')
    expect(body).not.toMatch(/lazy\(/)
  })

  test("the opening click warms the body alongside the corpus prefetch", () => {
    // The click is the guarantee that does not depend on timing: it gives the
    // load the shell's 120ms opening motion to finish in.
    expect(read("rail-workspace-panel-shell.tsx")).toContain("void warmWorkspacePanelReview()")
  })

  test("the boot warm-up runs from the workbench shell, not the panel shell", () => {
    // RailWorkspacePanelShell is mounted BY the opening click (rail-workbench-shell
    // gates it on workspacePanelMounted(), whose signal starts closed), so an idle
    // warm-up placed there could never run before the open it is meant to warm.
    expect(read("rail-workbench-shell.tsx")).toContain("warmWorkspacePanelReviewWhenIdle()")
    expect(read("rail-workspace-panel-shell.tsx")).not.toContain("warmWorkspacePanelReviewWhenIdle")
  })
})
