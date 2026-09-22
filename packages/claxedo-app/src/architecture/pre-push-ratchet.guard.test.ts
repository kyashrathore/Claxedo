import { describe, expect, test } from "bun:test"

const root = new URL("../../../../", import.meta.url)

// `Array.prototype.sort` without a comparator coerces to string and compares
// by UTF-16 code unit; naming that explicitly is what the lint rule asks for.
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

describe("pre-push architecture ratchet", () => {
  test("lints, then typechecks, then runs every root guard and source-closure policy", async () => {
    const manifest = await Bun.file(new URL("package.json", root)).json()

    expect(manifest.scripts["test:architecture-ratchets"]).toBe(
      // The helper-duplication ratchet is pinned here for the same reason as the
      // closure walk: a gate that is easy to drop from the script is a gate that
      // silently stops running.
      "BUN_CONFIG_FILE=./script/architecture-ratchets.bunfig.toml bun test ./script/agent-plugins-retirement.test.ts ./script/upstream-engine-retirement.test.ts ./script/bun-build.test.ts && bun ./script/product-boundary/verify.ts --all --source-only && bun ./script/helpers/verify.ts",
    )
    expect(manifest.scripts.prepush).toBe(
      "bun run lint && bun run typecheck && bun run test:ci-policy && bun run test:architecture-ratchets",
    )
    expect(await Bun.file(new URL(".husky/pre-push", root)).text()).toContain("bun run prepush")
  })

  test("CI runs the same gates the hook does, so a bypassed push still fails", async () => {
    // The hook is the only thing that ran the ratchets until this workflow
    // picked them up; `git push --no-verify` skipped them entirely. Pinning the
    // commands here means deleting a step reddens a test rather than
    // silently widening what reaches `dev`.
    const workflow = await Bun.file(new URL(".github/workflows/typecheck.yml", root)).text()
    for (const command of ["bun run lint", "bun run test:ci-policy", "bun run test:architecture-ratchets"]) {
      expect(workflow).toContain(`run: ${command}`)
    }
    expect(workflow).toContain("bun turbo typecheck --affected")
  })

  test("pins every lint exemption, so loosening the gate cannot pass unreviewed", async () => {
    // `bun run lint` is only a gate while its exemptions stay small and argued.
    // Nothing else in the repository reads `.oxlintrc.json`, so without this a
    // file-wide override — or flipping a category back to "warn" — is a silent
    // one-line edit. Pinning the surface means widening it reddens a test and
    // has to be defended in review, which is the whole enforcement mechanism.
    //
    // JSONC: only whole-line `//` comments are stripped, so the `https://`
    // inside the `$schema` value survives.
    const source = await Bun.file(new URL(".oxlintrc.json", root)).text()
    const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""))

    expect(config.categories).toEqual({ correctness: "error", suspicious: "error" })
    expect(config.options.typeAware).toBe(true)

    // Every override is either one of the two test-scoped glob entries or a
    // single exact path. Checking only the exact paths would let a new glob
    // entry through untouched, so both partitions are pinned and their sizes
    // are asserted — a third glob entry fails on the count alone.
    const globbed = config.overrides.filter((o: { files: string[] }) =>
      o.files.some((f) => f.includes("*")),
    )
    const exact = config.overrides.filter((o: { files: string[] }) =>
      o.files.every((f) => !f.includes("*")),
    )
    expect(globbed.length + exact.length).toBe(config.overrides.length)
    expect(globbed.length).toBe(2)

    expect(globbed[0].files).toEqual([
      "**/*.test.ts", "**/*.test.tsx", "**/*.test.mjs",
      "**/*.vitest.ts", "**/*.vitest.tsx", "**/*.spec.ts",
      "**/e2e/**", "**/test-support/**", "**/__tests__/**", "**/tests/**",
    ])
    expect(globbed[1].files).toEqual([
      "packages/claxedo-app/**/*.test.ts", "packages/claxedo-app/**/*.test.tsx",
      "packages/claxedo-app/**/*.vitest.ts", "packages/claxedo-app/**/*.vitest.tsx",
      "packages/claxedo-app/e2e/**", "packages/claxedo-app/**/test-support/**",
      "packages/claxedo-app/**/tests/**",
    ])

    // Exact-path overrides: one file per entry, each a module whose own job is
    // the claim it excuses.
    expect(exact.flatMap((o: { files: string[] }) => o.files).sort(byCodePoint)).toEqual([
      "packages/claxedo-app/src/lib/total-record.ts",
      "packages/claxedo-app/src/platform/identity/brand.ts",
      "packages/claxedo-app/src/platform/persistence/solid-store-erasure.ts",
      "packages/claxedo-app/vitest.config.ts",
      "packages/claxedo-channels/src/transport/chat-sdk-memory-state.ts",
      "packages/claxedo-server-core/src/platform/auth/branded-id.ts",
      "packages/workspace-relay/src/upstream-websocket.ts",
      "packages/workspace-runtime/src/client/request.ts",
    ])

    // Only these three type rules may be relaxed anywhere. `no-floating-promises`,
    // `no-base-to-string` and the correctness category stay on everywhere.
    const relaxed = new Set(config.overrides.flatMap((o: { rules: object }) => Object.keys(o.rules)))
    expect([...relaxed].sort(byCodePoint)).toEqual([
      "typescript/await-thenable",
      "typescript/no-redundant-type-constituents",
      "typescript/no-unsafe-type-assertion",
    ])
    for (const override of config.overrides) {
      expect(Object.values(override.rules)).toEqual(Object.values(override.rules).map(() => "off"))
    }
  })

  test("teaches both agents to fix accidental edges before changing ceilings", async () => {
    for (const file of ["AGENTS.md", "CLAUDE.md"]) {
      const instructions = await Bun.file(new URL(file, root)).text()
      expect(instructions).toContain("bun run test:architecture-ratchets")
      expect(instructions).toContain("do not blindly raise a ceiling or baseline")
      expect(instructions).toContain("Never hide a dependency from the scanner with an opaque dynamic import")
    }
  })
})
