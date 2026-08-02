import { describe, expect, test } from "vitest"
import { WORKSPACE_ID_LENGTH, isMintedWorkspaceId, newWorkspaceId, randomIdSuffix } from "./workspace-id"

/**
 * Chain A of the 2026-07-27 security review: workspace ids were
 * `` `ws_${Date.now().toString(36)}` `` — a bare millisecond timestamp with no
 * random component, so an attacker who knew roughly when a victim created a
 * workspace could enumerate the entire plausible window and hit the exact id.
 *
 * These tests fail against that old generator. The load-bearing one is
 * "entropy survives a frozen clock": every time-only generator produces
 * IDENTICAL output when the clock does not move, and that is precisely the
 * property an enumeration attack exploits.
 */

describe("workspace id minting", () => {
  test("keeps the ws_ prefix and stays URL-safe and short", () => {
    const id = newWorkspaceId()
    expect(id.startsWith("ws_")).toBe(true)
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(isMintedWorkspaceId(id)).toBe(true)
    // Accepted by every workspace-id sniffer in the tree
    // (workspace-store.ts:118, claxedo-app legacy-resolver.ts:15).
    expect(id).toMatch(/^ws_[A-Za-z0-9_-]+$/)
  })

  test("stays inside the driver-side length budgets", () => {
    // Workspace ids are embedded, untruncated, in driver resource names. Two
    // ceilings bind, and blowing either is a silent production failure rather
    // than a test failure, so they are asserted here at the source:
    //
    //   sandbox-manager/src/drivers/daytona.ts:119 `daytonaSecretName`
    //     `claxedo-<id>-<secretName>`, no truncation. Longest secret name in
    //     the tree is CLAXEDO_GITHUB_CLONE_AUTH (25, repository-clone.ts:10).
    //   sandbox-manager/src/drivers/exe.ts:45 `exeWorkspaceName`
    //     slices the sanitized id to 30 chars for its reattach slug.
    const id = newWorkspaceId()
    expect(id).toHaveLength(WORKSPACE_ID_LENGTH)
    expect(WORKSPACE_ID_LENGTH).toBeLessThanOrEqual(30)
    expect(`claxedo-${id}-CLAXEDO_GITHUB_CLONE_AUTH`.length).toBeLessThanOrEqual(63)
    // `exe`'s sanitizer only rewrites non-[a-z0-9] runs to "-", so a minted id
    // keeps its length and never reaches the 30-char slice.
    expect(id.toLowerCase().replace(/[^a-z0-9]+/g, "-")).toHaveLength(WORKSPACE_ID_LENGTH)
  })

  test("keeps a sortable millisecond time prefix", () => {
    const earlier = newWorkspaceId(1_700_000_000_000)
    const later = newWorkspaceId(1_700_000_001_000)
    expect(earlier.split("_")[1]).toBe((1_700_000_000_000).toString(36))
    expect(later.split("_")[1]).toBe((1_700_000_001_000).toString(36))
    // Base36 millis are fixed-width for every timestamp this century, so plain
    // string ordering still tracks creation order.
    expect(earlier < later).toBe(true)
  })

  test("entropy survives a frozen clock — the property the old generator lacked", () => {
    // The old `ws_${Date.now().toString(36)}` returns the SAME string for every
    // call within one millisecond. Pin the clock and demand uniqueness anyway.
    const frozen = 1_700_000_000_000
    const ids = new Set(Array.from({ length: 500 }, () => newWorkspaceId(frozen)))
    expect(ids.size).toBe(500)
    // And the time-derived part really is identical across all of them, so the
    // uniqueness above can only be coming from the random suffix.
    const prefixes = new Set([...ids].map((id) => id.slice(0, id.lastIndexOf("_"))))
    expect(prefixes.size).toBe(1)
  })

  test("ids are unique across rapid successive real-clock calls", () => {
    const ids = Array.from({ length: 2_000 }, () => newWorkspaceId())
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("the suffix carries enough entropy to be unguessable", () => {
    const suffix = randomIdSuffix()
    // 16 symbols over a 32-symbol alphabet = 80 bits.
    expect(suffix).toHaveLength(16)
    expect(suffix).toMatch(/^[0-9a-hjkmnp-tv-z]{16}$/)

    // Every alphabet position should be exercised across a large sample; a
    // constant or low-entropy suffix collapses this to a handful of symbols.
    const symbols = new Set([...Array.from({ length: 200 }, () => randomIdSuffix()).join("")])
    expect(symbols.size).toBeGreaterThan(24)
  })

  test("an id is not derivable from its own timestamp", () => {
    // Knowing the exact creation millisecond must not let an attacker
    // reconstruct the id — the whole point of Chain A.
    const frozen = 1_700_000_000_000
    const target = newWorkspaceId(frozen)
    const guesses = new Set(Array.from({ length: 5_000 }, () => newWorkspaceId(frozen)))
    expect(guesses.has(target)).toBe(false)
  })
})
