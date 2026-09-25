import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runConformance, type ConformanceBackend } from "./test-support/run"
import { ensurePinnedPi, PINNED_PI } from "../../e2e/harness/pinned-pi"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"
import { PiRpcTransport } from "../transports/pi-rpc"

type PiBackend = ConformanceBackend & { root: string; agentDir: string; server: Awaited<ReturnType<typeof startScriptedModelServer>> }

const extension = `export default function (pi) {
  pi.registerCommand("conformance-ui", {
    description: "Exercise Pi extension UI",
    handler: async (args, ctx) => {
      ctx.ui.notify("Pi conformance notice", "info")
      ctx.ui.setStatus("conformance", "Pi conformance status")
      ctx.ui.setWidget("conformance", ["Pi conformance widget"])
      ctx.ui.setTitle("Pi conformance title")
      ctx.ui.setEditorText("Pi conformance editor")
      const mode = args.trim()
      const value = mode === "expire" ? await ctx.ui.confirm("Expire", "Expire this request?", { timeout: 100 })
        : mode === "input" ? await ctx.ui.input("Input", "")
        : mode === "editor" ? await ctx.ui.editor("Editor", "")
        : await ctx.ui.select("Choose", ["Allow", "Deny"])
      pi.setSessionName(value === "Allow" || value === true ? "Pi allowed" : "Pi denied")
      pi.sendUserMessage("Reply with exactly this one token: PICONFORMUI")
    },
  })
}
`

async function backend(): Promise<PiBackend> {
  await ensurePinnedPi()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-conformance-"))
  const directory = path.join(root, "work")
  const agentDir = path.join(root, "pi-agent")
  await fs.mkdir(directory)
  await fs.mkdir(agentDir)
  await fs.mkdir(path.join(agentDir, "extensions"))
  await fs.writeFile(path.join(agentDir, "extensions", "conformance.ts"), extension)
  await fs.writeFile(path.join(directory, "conformance.txt"), "conformance tool result\n")
  const authFile = path.join(agentDir, "auth.json")
  await fs.writeFile(authFile, Buffer.from('{"sentinel":"owner-auth-must-stay"}\n'))
  const port = await reservePort()
  const server = await startScriptedModelServer({ port, red: false })
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
    openai: { baseUrl: server.v1Url, apiKey: "pi-conformance-placeholder" },
  } }))
  return {
    root, agentDir, directory, authFile, server, uiCommand: "conformance-ui",
    mismatchOrigin: { actor: { kind: "person", userId: "member" }, via: "relay", reissued: false },
    harness: { id: "pi", access: "native" }, expectedMcp: "none",
    model: { providerID: "pi", modelID: "openai/gpt-4.1" },
    credentials: { providers: {}, secrets: {}, leaseGeneration: "conformance" },
    hold: (marker) => server.holdTextReplies(marker),
    scriptTool: (name, input) => server.scriptTool({ name, input }),
    close: async () => { await server.close(); releasePort(port); await fs.rm(root, { recursive: true, force: true }) },
  }
}

runConformance({
  name: "pi-rpc",
  backend,
  makeTransport(services, state) {
    const pi = state as PiBackend
    return new PiRpcTransport(services, {
      binary: PINNED_PI, placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true,
      stateRoot: path.join(pi.root, "claxedo"), ownerAgentDir: pi.agentDir,
    })
  },
})

runConformance({
  name: "pi-rpc brokered",
  async backend() {
    const state = await backend()
    const rotated: { port: number; server: Awaited<ReturnType<typeof startScriptedModelServer>> }[] = []
    const origin = { actor: { kind: "person" as const, userId: "member" }, via: "relay" as const, reissued: false }
    const credentials = { providers: { openai: { baseUrl: state.server.url, placeholder: "pi-broker-placeholder", authMode: "api-key" as const } },
      secrets: {}, leaseGeneration: "brokered" }
    const root = path.join(state.root, "plugin")
    await fs.mkdir(path.join(root, "extensions"), { recursive: true })
    await fs.writeFile(path.join(root, "extensions", "conformance.ts"), extension)
    return { ...state, origin, credentials, authFile: undefined,
      mismatchOrigin: { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false },
      projection: { generation: "g1", mcpServers: [], notApplied: [], pluginRoots: [{ pluginInstanceId: "conformance", root, dataRoot: root }] },
      rotate: async () => {
        const port = await reservePort()
        const server = await startScriptedModelServer({ port, red: false })
        rotated.push({ port, server })
        return { credentials: { ...credentials, providers: { openai: { ...credentials.providers.openai, baseUrl: server.url } },
          leaseGeneration: "rotated" }, observed: () => server.requests.length > 0 }
      },
      close: async () => {
        await Promise.all(rotated.map(async ({ port, server }) => { await server.close(); releasePort(port) }))
        await state.close()
      },
    }
  },
  makeTransport(services, state) {
    const pi = state as PiBackend
    return new PiRpcTransport(services, {
      binary: PINNED_PI, placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true,
      stateRoot: path.join(pi.root, "claxedo"), ownerAgentDir: pi.agentDir,
    })
  },
})
