import { expect, test } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../../../..")

test("the control plane has only a Cloudflare composition", () => {
  expect(existsSync(path.join(root, "packages/claxedo-server/src/deployments/self-hosted-node"))).toBe(false)
  expect(existsSync(path.join(root, "packages/claxedo-server/src/deployments/hosted-workerd/core-worker.cf.ts"))).toBe(true)
})

test("session authority conformance has only the D1 adapter", () => {
  expect(existsSync(path.join(root, "packages/claxedo-server-core/src/authority/adapters/sqlite"))).toBe(false)
  const suite = readFileSync(path.join(root, "packages/claxedo-server/src/authority/adapters/d1/session-authority.test.ts"), "utf8")
  expect(suite).toContain("exercisePrivateSessionAuthorityConformance")
  expect(suite).toContain("exerciseSessionTurnAuthorityConformance")
})

test("the relay publishes no Bun composition", () => {
  const directory = path.join(root, "packages/workspace-relay")
  const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"))
  expect(manifest.exports["./bun"]).toBeUndefined()
  expect(existsSync(path.join(directory, "src/bun.ts"))).toBe(false)
  expect(existsSync(path.join(directory, "src/main.ts"))).toBe(false)
  expect(existsSync(path.join(directory, "src/cloudflare.ts"))).toBe(true)
})

test("the control plane does not own a machine tunnel manager", () => {
  const source = readFileSync(path.join(root, "packages/claxedo-server/src/host-tunnel.ts"), "utf8")
  expect(source).not.toContain("export async function startMachineHostTunnel")
  expect(source).not.toContain("export function stopMachineHostTunnel")
  expect(source).not.toContain("export function hasMachineHostTunnel")
})
