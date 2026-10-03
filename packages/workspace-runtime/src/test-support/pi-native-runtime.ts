import { createWorkspaceRuntimeApp } from "../server"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { loopbackMachineLoginPolicy } from "../testing"

export type PiNativeRoots = { directory: string; storeRoot: string; harnessStateRoot: string; providerUrl: string }

export const PI_NATIVE_MODEL = { providerID: "pi", modelID: "groq/llama-3.1-8b-instant" }
export const PI_DIRECT_SECRET = "proof-direct-secret"
export const PI_BROKER_PLACEHOLDER = "proof-placeholder"

export function piNativeSnapshot(providerUrl: string) {
  return {
    version: 4 as const,
    defaultHarness: { kind: "native" as const, harnessId: "pi" as const },
    mcp: {}, connections: [], commands: [],
    auth: {
      machineOwnerUserId: "local",
      accounts: { local: { groq: { baseUrl: `${providerUrl}/bindings/proof`, placeholder: PI_BROKER_PLACEHOLDER, authMode: "bearer" as const, apiPath: "/openai/v1" } } },
      direct: { local: { groq: { delivery: "direct" as const, baseUrl: providerUrl, apiPath: "/openai/v1", secret: PI_DIRECT_SECRET, authKind: "api-key" as const } } },
    },
  }
}

export function piNativeRuntime(roots: PiNativeRoots) {
  return createWorkspaceRuntimeApp({
    placement: loopbackMachineLoginPolicy(),
    target: { workspaceId: "workspace-proof", directory: roots.directory },
    sessionIdWorkspace: () => undefined,
    storeRoot: roots.storeRoot,
    harnessStateRoot: roots.harnessStateRoot,
    harness: { kind: "native", harnessId: "pi" },
    exposure: loopbackWorkspaceRuntimeExposure(),
  })
}

if (process.argv[2] === "crash-child") {
  const roots = JSON.parse(process.argv[3]!) as PiNativeRoots
  const runtime = piNativeRuntime(roots)
  await runtime.host.apply(piNativeSnapshot(roots.providerUrl))
  const post = (resource: string, body: object) => runtime.app.request(`http://localhost/${resource}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const session = await (await post("session?nativeHarness=pi", { id: "crash-proof", title: "Crash proof", model: PI_NATIVE_MODEL })).json() as { id: string }
  await post(`session/${session.id}/prompt_async`, { messageID: "held", model: PI_NATIVE_MODEL, parts: [{ type: "text", text: "Answer after the crash" }] })
  process.stdout.write("prompted\n")
}
