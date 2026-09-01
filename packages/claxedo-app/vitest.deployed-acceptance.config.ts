import { defineConfig } from "vitest/config"

/**
 * The offline gate over the deployed-Cloudflare acceptance HARNESS.
 *
 * `e2e/playwright/deployed-cloudflare-acceptance.test.ts` was collected by no
 * runner before this config existed: it is a vitest file, but
 * `vitest.config.ts` includes only `src/**` and `playwright.config.ts` matches
 * `**\/*.spec.ts`. `tsconfig.e2e.json` typechecked it, so it compiled while
 * none of its assertions ever ran — the harness that proves the deployed
 * system was itself unproven.
 *
 * What it covers is deliberately narrow and entirely OFFLINE: the exported
 * pieces of the harness that are wrong-or-right without a deployment — the
 * origin/run-id parsing, and the signed payload literals the authority
 * verifies byte for byte. No network, no credentials, ~400ms. That is why it
 * is chained into this package's default `test` script rather than kept for
 * on-demand use: a payload literal drifting from the authority's verifier is
 * exactly the kind of break that must fail in CI, long before anyone points
 * the runner at a live worker.
 *
 * The LIVE run is a different command and a different thing entirely —
 * `bun run test:e2e:deployed-cloudflare`, which drives a real deployment
 * through Playwright. See the header of `e2e/deployed-cloudflare-acceptance.ts`
 * for its stages and required environment. Nothing here talks to it.
 */
export default defineConfig({
  resolve: { conditions: ["development", "node"] },
  test: {
    environment: "node",
    include: ["e2e/playwright/deployed-cloudflare-acceptance.test.ts"],
  },
})
