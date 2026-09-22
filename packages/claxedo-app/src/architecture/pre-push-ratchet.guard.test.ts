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
      "bun run lint && bun run typecheck && bun run test:architecture-ratchets",
    )
    expect(await Bun.file(new URL(".husky/pre-push", root)).text()).toContain("bun run prepush")
  })

  test("CI runs the same three gates the hook does, so a bypassed push still fails", async () => {
    // The hook is the only thing that ran the ratchets until this workflow
    // picked them up; `git push --no-verify` skipped them entirely. Pinning the
    // three commands here means deleting a step reddens a test rather than
    // silently widening what reaches `dev`.
    const workflow = await Bun.file(new URL(".github/workflows/typecheck.yml", root)).text()
    for (const command of ["bun run lint", "bun run test:architecture-ratchets"]) {
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

    // An override either turns rules on or turns them off, never both. The
    // ones that turn rules on widen the gate and are pinned by content; every
    // other override is an exemption, and those are pinned by path below.
    type Override = { files: string[]; rules: Record<string, string> }
    const overrides: Override[] = config.overrides
    const tightening = overrides.filter((o) => Object.values(o.rules).every((level) => level === "error"))
    const exemptions = overrides.filter((o) => Object.values(o.rules).every((level) => level === "off"))
    expect(tightening.length + exemptions.length).toBe(overrides.length)

    // The browser-delivered packages write nothing to the devtools console;
    // handled errors go to PostHog through `platform/telemetry/analytics.ts`.
    expect(tightening).toEqual([
      {
        files: [
          "packages/claxedo-app/src/**",
          "packages/claxedo-web/src/**",
          "packages/session-app/src/**",
          "packages/session-ui/src/**",
          "packages/ui/src/**",
        ],
        rules: { "no-console": "error" },
      },
    ])

    // Every exemption is either one of the three test-scoped glob entries or a
    // single exact path. Checking only the exact paths would let a new glob
    // entry through untouched, so both partitions are pinned and their sizes
    // are asserted — a fourth glob entry fails on the count alone.
    const globbed = exemptions.filter((o) => o.files.some((f) => f.includes("*")))
    const exact = exemptions.filter((o) => o.files.every((f) => !f.includes("*")))
    expect(globbed.length + exact.length).toBe(exemptions.length)
    expect(globbed.length).toBe(3)

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
    // Test code and stories inside the no-console packages may print; the
    // production sources they sit beside stay under the tightening above.
    expect(globbed[2].files).toEqual([
      "packages/claxedo-app/src/**/*.test.ts", "packages/claxedo-app/src/**/*.test.tsx",
      "packages/claxedo-app/src/**/*.vitest.ts", "packages/claxedo-app/src/**/*.vitest.tsx",
      "packages/claxedo-app/src/**/test-support/**", "packages/claxedo-app/src/**/tests/**",
      "packages/claxedo-app/src/**/__tests__/**",
      "packages/claxedo-web/src/**/*.test.ts",
      "packages/session-app/src/**/*.test.ts", "packages/session-app/src/**/*.test.tsx",
      "packages/session-ui/src/**/*.test.ts", "packages/session-ui/src/**/*.test.tsx",
      "packages/ui/src/**/*.test.ts", "packages/ui/src/**/*.test.tsx",
      "packages/ui/src/**/*.stories.tsx", "packages/ui/src/storybook/**",
    ])
    expect(globbed[2].rules).toEqual({ "no-console": "off" })

    // Exact-path overrides: one file per entry, each a module whose own job is
    // the claim it excuses.
    expect(exact.flatMap((o) => o.files).sort(byCodePoint)).toEqual([
      "packages/claxedo-app/src/lib/total-record.ts",
      "packages/claxedo-app/src/platform/identity/brand.ts",
      "packages/claxedo-app/src/platform/persistence/solid-store-erasure.ts",
      "packages/claxedo-app/vitest.config.ts",
      "packages/claxedo-channels/src/transport/chat-sdk-memory-state.ts",
      "packages/claxedo-server-core/src/platform/auth/branded-id.ts",
      "packages/workspace-relay/src/upstream-websocket.ts",
      "packages/workspace-runtime/src/client/request.ts",
    ])

    // Only these rules may be relaxed anywhere, and `no-console` only where it
    // was first turned on. `no-floating-promises`, `no-base-to-string` and the
    // correctness category stay on everywhere.
    const relaxed = new Set(exemptions.flatMap((o) => Object.keys(o.rules)))
    expect([...relaxed].sort(byCodePoint)).toEqual([
      "no-console",
      "typescript/await-thenable",
      "typescript/no-redundant-type-constituents",
      "typescript/no-unsafe-type-assertion",
    ])
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
