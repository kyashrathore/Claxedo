import { describe, expect, test } from "vitest"
import { forbiddenPackagePath } from "../check-package-boundary"

describe("check-package-boundary", () => {
  test("rejects secrets, generated output, dependency directories, and nested deploy packages", () => {
    expect([
      ".env.local",
      "scripts/sandbox/.build/package.json",
      "scripts/sandbox/cloudflare-worker/package.json",
      "scripts/sandbox/cloudflare-worker/package-lock.json",
      "scripts/sandbox/cloudflare-worker/Dockerfile",
      "scripts/sandbox/cloudflare-worker/node_modules/wrangler/index.js",
      "scripts/sandbox/cloudflare-worker/.sandbox-build/source/package.json",
      "scripts/sandbox/cloudflare-worker/.wrangler/tmp/build/index.js",
      "scripts/sandbox/live/live-test.ts",
      "dist-worker/index.js",
      "coverage/index.html",
    ].map(forbiddenPackagePath)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ])
  })

  test("allows normal source files and env examples", () => {
    expect(forbiddenPackagePath(".env.example")).toBe(false)
    expect(forbiddenPackagePath("src/sandbox-manager-adapters/provision-events.ts")).toBe(false)
    expect(forbiddenPackagePath("scripts/sandbox/build-sandbox-image.ts")).toBe(false)
  })
})
