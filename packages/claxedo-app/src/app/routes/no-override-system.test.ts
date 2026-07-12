import { describe, expect, test } from "bun:test"

// Replaces the former `override-batch-contract.test.ts`, a 331-line suite of
// raw-source-text `.toContain` assertions across ~25 files. Per the pages
// audit those content greps were snapshot theater (they broke on harmless
// renames and taught nothing about behavior) and the behavior they nominally
// guarded is covered by real `*.test.ts` siblings elsewhere. The ONE genuine
// invariant they encoded — that the pre-fork "overrides" resolution system no
// longer exists (see CONTRIBUTING.md "History: the override system") — is kept
// here as a lightweight fixture-presence check, with no source-text grepping.

const srcRoot = new URL("../", import.meta.url)

describe("no upstream override system", () => {
  test("there is no src/overrides directory", async () => {
    // A directory materializes as a readable "file" handle; a missing path does
    // not. Either way, no `overrides` tree may exist under src/.
    const overrides = Bun.file(new URL("overrides", srcRoot))
    expect(await overrides.exists()).toBe(false)
  })

  test("route-owning pages resolve to first-party files, not override shadows", async () => {
    // The former suite asserted, per file, that an `overrides/<path>` shadow was
    // absent. Collapsed here to the canonical route pages: each real source
    // exists and no parallel override copy does.
    const routeOwners = [
      "app.tsx",
      "pages/session.tsx",
      "pages/home.tsx",
      "pages/error.tsx",
      "pages/cli-login.tsx",
      "pages/session/use-session-commands.tsx",
      "pages/session/message-timeline.tsx",
      "pages/session/composer/session-composer-region.tsx",
    ]

    for (const relative of routeOwners) {
      expect(await Bun.file(new URL(relative, srcRoot)).exists()).toBe(true)
      expect(await Bun.file(new URL(`overrides/${relative}`, srcRoot)).exists()).toBe(false)
    }
  })
})
