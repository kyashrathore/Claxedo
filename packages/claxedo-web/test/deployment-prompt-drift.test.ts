import { describe, expect, test } from "bun:test"
import { claxedoRepositoryUrl, cloudflareDeploymentPrompt as prompt } from "../src/content/deployment"

// Drift guard for the "Deploy to Cloudflare" prompt.
//
// The prompt is copy-pasted into a fresh agent session, so every concrete fact it
// asserts — guide path, release script names, D1 bindings, adapter profile —
// must still be true of the configuration it claims to describe. This test
// re-derives those facts from the real files and fails when the two drift apart
// in either direction. The retired Clerk + Convex hosted prompt was removed
// with that product; the re-add path lives in the `clerk-convex-cp` skill.

const repository = new URL("../../../", import.meta.url)

const read = async (path: string) => {
  const file = Bun.file(new URL(path, repository))
  if (!(await file.exists())) throw new Error(`drift guard anchor is missing: ${path}`)
  return await file.text()
}

const json = async (path: string) => JSON.parse(await read(path)) as { scripts?: Record<string, string> }

const promptMentions = (value: string, what: string) => {
  expect(`${what} ${JSON.stringify(value)} present in prompt: ${prompt.includes(value)}`).toBe(
    `${what} ${JSON.stringify(value)} present in prompt: true`,
  )
}

describe("cloudflare deploy prompt: canonical guide and release path", () => {
  test("points at the generated user-deployed guide, not a retired product", async () => {
    promptMentions("public-docs/user-deployed-cloudflare.md", "canonical guide")
    expect(await Bun.file(new URL("public-docs/user-deployed-cloudflare.md", repository)).exists()).toBe(true)
    const guide = await read("public-docs/user-deployed-cloudflare.md")
    expect(guide).toContain("Better Auth + D1")
  })

  test("names the release, cutover, and greenfield-proof scripts that actually exist", async () => {
    for (const script of [
      "packages/claxedo-server/scripts/deploy/release-better-auth-d1.ts",
      "packages/claxedo-server/scripts/deploy/cutover-better-auth-d1.ts",
      "packages/claxedo-server/scripts/deploy/prove-greenfield-target-absence.ts",
      "packages/claxedo-server/scripts/deploy/greenfield-user-deployed.ts",
    ]) {
      expect(await Bun.file(new URL(script, repository)).exists()).toBe(true)
      promptMentions(script.replace("packages/claxedo-server/", ""), "deploy script")
    }
    const pkg = await json("packages/claxedo-server/package.json")
    expect(pkg.scripts?.["deploy:user-cloudflare:preflight"]).toBe(
      "bun run scripts/deploy/greenfield-user-deployed.ts --preflight",
    )
  })

  test("pins the better-auth-d1 adapter profile and the two D1 bindings", async () => {
    promptMentions("CLAXEDO_ADAPTER_PROFILE", "adapter profile env")
    promptMentions("better-auth-d1", "adapter profile value")
    promptMentions("AUTH_DB", "auth D1 binding")
    promptMentions("CONTROL_PLANE_DB", "control-plane D1 binding")
    const locked = await read(
      "packages/claxedo-server/src/deployments/hosted-workerd/better-auth-d1-locked-worker.cf.ts",
    )
    expect(locked).toContain("AUTH_DB")
    expect(locked).toContain("CONTROL_PLANE_DB")
  })

  test("contains no Clerk or Convex deployment surface", () => {
    for (const token of ["CLERK_", "CONVEX_", "VITE_CLERK", "VITE_CONVEX", "convex deploy", "bunx convex"]) {
      expect(prompt.includes(token), `retired token ${token} must not appear in prompt`).toBe(false)
    }
    promptMentions("clerk-convex-cp", "archived re-add skill")
  })

  test("prescribes bunx over npx", () => {
    expect(prompt).toContain("bunx wrangler")
    expect(prompt).toContain("bun install")
    expect(prompt.split("\n").filter((line) => line.trim().startsWith("npx "))).toEqual([])
    expect(prompt).toMatch(/Do NOT use "npx wrangler"/)
  })
})

describe("cloudflare deploy prompt: self-sufficiency and honesty", () => {
  test("carries the repository so a fresh session with no checkout can start", () => {
    expect(claxedoRepositoryUrl).toBe("https://github.com/kyashrathore/Claxedo")
    expect(prompt).toContain(claxedoRepositoryUrl)
    expect(prompt).toContain(`git clone ${claxedoRepositoryUrl}.git`)
    expect(prompt).toContain("cd Claxedo")
    const firstDeploy = prompt.indexOf("bun run deploy:user-cloudflare:preflight")
    expect(prompt.indexOf("git clone")).toBeLessThan(firstDeploy)
    expect(prompt.indexOf("cd Claxedo")).toBeLessThan(firstDeploy)
    expect(prompt.indexOf("bun install")).toBeLessThan(firstDeploy)
  })

  test("remains a single copy-pasteable block", () => {
    expect(typeof prompt).toBe("string")
    expect(prompt.trim()).toBe(prompt.trim())
    expect(prompt.length).toBeGreaterThan(2000)
    expect(prompt).not.toContain("\r")
    expect(prompt).not.toContain("TODO")
    expect(prompt).not.toContain("<placeholder>")
  })
})
