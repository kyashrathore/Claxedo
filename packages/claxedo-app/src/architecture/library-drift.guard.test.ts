import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import allowlist from "./library-drift-allowlist.json"

const repoRoot = path.resolve(import.meta.dir, "../../../..")

describe("library drift allowlist", () => {
  test("keeps all allowlisted drift files present", () => {
    expect(allowlist.filter((file) => !existsSync(path.join(repoRoot, file)))).toEqual([])
  })

  // Removed (hard-fork): the "drift vs upstream/dev" subset check diffed the
  // vendored ui/session-ui against the moving upstream/dev tip, which flagged
  // upstream's OWN post-fork additions (new i18n locales, package.json, sst-env
  // stubs) as Claxedo "drift" — the wrong signal. Post hard-fork we own the
  // vendored engine/UI as first-party source and no longer track upstream/dev;
  // after the one-commit history reset there is no shared ancestor to diff
  // against at all. The allowlist-presence check above is retained.
})
