import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { REPO_ROOT, SERVER_DIR } from "../../../harness/e2e/harness/node-loader"
import { bunPath } from "./scripted-world"

const execFileAsync = promisify(execFile)

export const COUNTER_PLUGIN = { id: "counter", name: "Counter", directory: path.join(SERVER_DIR, "src/plugin-backends/fixtures/counter") }

const RELEASE_CLI = path.join(REPO_ROOT, "packages/claxedo-plugin-build/src/release-cli.ts")

const TEST_KEY_ID = "test"

export type TestRegistry = {
  readonly dir: string
  readonly testKey: string
  readonly publish: (pluginDirectory: string) => Promise<void>
  readonly close: () => Promise<void>
}

export async function createTestRegistry(): Promise<TestRegistry> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair
  const signingKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64")
  const testKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-app-plugin-registry-"))
  const dir = path.join(root, "registry")
  await fs.mkdir(dir)
  const bun = await bunPath()
  return {
    dir,
    testKey,
    publish: async (pluginDirectory) => {
      await execFileAsync(bun, [RELEASE_CLI, pluginDirectory, dir], {
        cwd: REPO_ROOT,
        env: { ...process.env, CLAXEDO_APP_PLUGIN_REGISTRY_SIGNING_KEY: signingKey, CLAXEDO_APP_PLUGIN_REGISTRY_KEY_ID: TEST_KEY_ID },
      })
    },
    close: () => fs.rm(root, { recursive: true, force: true }),
  }
}
