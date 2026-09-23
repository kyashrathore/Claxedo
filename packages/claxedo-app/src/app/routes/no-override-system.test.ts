import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"

const srcRoot = new URL("../../", import.meta.url)

describe("no upstream override system", () => {
  test("there is no src/overrides directory", () => {
    expect(existsSync(new URL("overrides", srcRoot))).toBe(false)
  })

  test("route-owning pages resolve to first-party files, not override shadows", async () => {
    const routeOwners = [
      "app/entry/app.tsx",
      "features/session/ui/session-screen.tsx",
      "app/routes/home.tsx",
      "app/routes/error.tsx",
      "app/routes/cli-login.tsx",
      "features/session/ui/use-session-commands.tsx",
      "features/session/ui/message-timeline.tsx",
      "features/session/ui/composer/session-composer-region.tsx",
    ]

    for (const relative of routeOwners) {
      expect(await Bun.file(new URL(relative, srcRoot)).exists()).toBe(true)
      expect(await Bun.file(new URL(`overrides/${relative}`, srcRoot)).exists()).toBe(false)
    }
  })
})
