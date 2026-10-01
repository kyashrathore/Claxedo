import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import type { Stack } from "../../../claxedo-app/e2e/harness/stack"

const names = ["../../../claxedo-app/e2e/harness/stack", "../../../claxedo-app/e2e/harness/hosted-app-front", "../../../claxedo-app/e2e/harness/hosted-email", "../../../claxedo-app/e2e/harness/hosted-machine", "../../../claxedo-app/e2e/harness/scripted-world", "./hosted-stack", "./hosted-auth"]
const originals = await Promise.all(names.map(async (name) => [name, { ...await import(name) }] as const))
afterAll(() => { for (const [name, module] of originals) mock.module(name, () => module) })
const closed: string[] = []
const hostedStarts: unknown[] = []
const localStarts: unknown[] = []
const local = { url: "http://127.0.0.1:42000", dataDir: "/test/local", acp: { scriptDir: "/test/local/acp" },
  daemon: { restart: () => { throw new Error("Signed fixture cannot restart the local daemon") } }, close: async () => { closed.push("local") } } as unknown as Stack
mock.module("../../../claxedo-app/e2e/harness/stack", () => ({ safeLabel: (label: string) => label, startStack: async (input: unknown) => { localStarts.push(input); return local } }))
mock.module("./hosted-stack", () => ({
  startHostedStack: async (...args: unknown[]) => {
    hostedStarts.push(args)
    return { workerUrl: "https://127.0.0.1:42001", certificate: "/test/worker-ca.pem", model: {}, provisionOwnerClaim: async () => "owner-claim", close: async () => { closed.push("hosted") } }
  },
}))
mock.module("./hosted-auth", () => ({ hostedFetch: async () => Response.json({}) }))
mock.module("../../../claxedo-app/e2e/harness/hosted-app-front", () => ({ startHostedAppFront: async () => ({ trust: {}, close: async () => { closed.push("front") } }) }))
mock.module("../../../claxedo-app/e2e/harness/hosted-email", () => ({ signUpHostedEmail: async () => ({ name: "Ada Owner", subject: "owner", person: { id: "owner", cookie: "owner-cookie" }, transport: async () => ({ status: 200, body: "{}" }) }) }))
mock.module("../../../claxedo-app/e2e/harness/scripted-world", () => ({ prepareScriptedServer: async () => {} }))
mock.module("../../../claxedo-app/e2e/harness/hosted-machine", () => ({ startHostedMachine: async () => ({ makeWorkspace: async () => ({ id: "ws_owned", directory: "/test/folder", projectId: "prj_d1" }), close: async () => { closed.push("machine") } }) }))
const { startSignedStack } = await import("../../../claxedo-app/e2e/harness/signed-stack")

beforeEach(() => { closed.length = 0; hostedStarts.length = 0; localStarts.length = 0 })

test("the signed fixture boots workerd with its exact browser origin and drains the machine before stopping D1 and relay storage", async () => {
  const signed = await startSignedStack({ label: "lifecycle", frontPort: 42001, distDir: "/test/app" })
  expect(hostedStarts).toHaveLength(1)
  expect(hostedStarts[0]).toEqual(["lifecycle", { apiOrigin: signed.url, appOrigin: signed.url, emailPassword: true }])
  expect(localStarts).toEqual([{ label: "lifecycle", frontPort: 42001, distDir: "/test/app", daemonEnv: { NODE_EXTRA_CA_CERTS: "/test/worker-ca.pem" } }])
  expect(signed.local).toBe(local)
  expect(await signed.makeWorkspace("owned")).toEqual({ id: "ws_owned", directory: "/test/folder", projectId: "prj_d1" })
  await signed.close()
  expect(closed).toEqual(["machine", "local", "hosted", "front"])
})
