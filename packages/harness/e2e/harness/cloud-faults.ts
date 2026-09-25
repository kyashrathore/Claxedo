import type { SandboxDriver } from "@claxedo/sandbox-manager"

export type CloudFault = "config-push-refused" | "broker-secret-withheld"

export function installCloudConfigFault(fault: string | undefined) {
  if (fault !== "config-push-refused") return
  const original = globalThis.fetch
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    if (new URL(url).pathname === "/api/wr/config" && method === "POST") {
      return Promise.resolve(new Response("cloud config push refused by test fault", { status: 503 }))
    }
    return original(input, init)
  }, { preconnect: original.preconnect })
}

export function cloudFaultDriver<T extends SandboxDriver>(driver: T, fault: string | undefined): T {
  if (fault !== "broker-secret-withheld") return driver
  return {
    ...driver,
    ensureHost: (input) => driver.ensureHost({ ...input, secrets: [] }),
  }
}
