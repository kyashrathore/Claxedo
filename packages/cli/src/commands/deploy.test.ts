import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { deploy, generatedConfig } from "./deploy"

test("deploy rejects removed split-placement options before doing platform work", async () => {
  await expect(deploy(["--tools", "daytona"])).rejects.toThrow("Unknown deploy option")
  await expect(deploy(["--harness=pi"])).rejects.toThrow("Unknown deploy option")
})

describe("operator-supplied app/region", () => {
  test.each([
    "../escape",
    "a/b",
    'a"b',
    "a\nb",
    "100%app",
    "$HOME",
    "app; rm -rf /",
    "UPPER",
    "-leading",
    "trailing-",
    "a".repeat(64),
    "",
  ])("rejects the traversal-looking or non-identifier app name %j", async (app) => {
    await expect(deploy(["--yes", `--app=${app}`])).rejects.toThrow("invalid Fly app name")
  })

  test.each(["../../x", "$HOME", "100%", "us-west-1", 'a"b', "sinn"])("rejects the region %j", async (region) => {
    await expect(deploy(["--yes", "--app=ok-app", `--region=${region}`])).rejects.toThrow("invalid Fly region")
  })

  describe("--generate-only inside a monorepo clone", () => {
    const dirs: string[] = []
    afterEach(async () => {
      for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
    })

    async function monorepo() {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-deploy-"))
      dirs.push(root)
      await fs.mkdir(path.join(root, "packages/claxedo-server"), { recursive: true })
      await fs.writeFile(path.join(root, "packages/claxedo-server/Dockerfile"), "FROM scratch\n")
      return root
    }

    test("an ordinary deploy writes <app>.fly.toml inside the repo root", async () => {
      const root = await monorepo()
      const cwd = process.cwd()
      process.chdir(root)
      try {
        await deploy(["--yes", "--generate-only", "--app=good-app-1", "--region=sin"])
      } finally {
        process.chdir(cwd)
      }
      const toml = await fs.readFile(path.join(root, "good-app-1.fly.toml"), "utf8")
      expect(toml).toContain('app = "good-app-1"')
      expect(toml).toContain('primary_region = "sin"')
      expect(toml).toContain("[http_service]")
    })
  })

  test("the TOML serializer escapes quotes, backslashes and control characters", () => {
    const toml = generatedConfig({ app: 'x"\ninjected=true\\', region: "sin" })
    expect(toml).toContain('app = "x\\"\\ninjected=true\\\\"')
    expect(toml).not.toContain('x"\ninjected')
    const control = generatedConfig({ app: "a\u0007b", region: "sin" })
    expect(control).toContain('app = "a\\u0007b"')
  })
})
