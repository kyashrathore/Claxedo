import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * What the package hands out.
 *
 * Unit 7's rule is that a deployment cannot reach a composition that skipped
 * its posture check. `startServer` composes without one — it is the inner call
 * `startSelfHostedServer` makes after the gate passes — so re-exporting it
 * would put an ungated path on the public surface, and a future consumer would
 * reach for the shorter name.
 *
 * Read as source rather than by importing: importing the entry pulls the whole
 * control plane, and what is being asserted is the EXPORT LIST, which is a
 * property of the text.
 */

const index = readFileSync(path.resolve(import.meta.dirname, "../../index.ts"), "utf8")

describe("the package's public entry", () => {
  test("offers the gated self-hosted start", () => {
    expect(index).toContain("startSelfHostedServer")
  })

  test("does not offer the ungated one", () => {
    // `startServer` stays internal. A consumer reaching it would boot a
    // configuration this package refuses at its own entry.
    const exported = index.match(/export \{[\s\S]*?\} from/g)?.join("\n") ?? ""

    expect(exported).not.toMatch(/\bstartServer\b/)
  })

  test("offers no `createApp`, under any spelling", () => {
    // The old public name. The plan requires removal with no forwarding
    // export, so a deployment cannot silently keep running the mixed
    // composition.
    expect(index).not.toMatch(/\bcreateApp\b/)
  })

  test("the export scan is not vacuous", () => {
    // Positive control: two assertions above are "does not contain", which is
    // what an empty scan also reports.
    const exported = index.match(/export \{[\s\S]*?\} from/g)?.join("\n") ?? ""

    expect(exported).toContain("createSelfHostedApp")
    expect(exported.length).toBeGreaterThan(200)
  })
})
