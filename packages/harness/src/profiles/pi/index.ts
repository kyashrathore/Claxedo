import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { piCredentialProviderIDs, type PromptModel } from "@claxedo/agent-runtime-contract"
import type { PluginProjection, ResolvedCredentials, TurnOrigin } from "../../contract"
import { selectTurnCredentials, type CredentialProfile, type RuntimePlacement } from "../../registry/credentials"

export type PiProfile = {
  kind: CredentialProfile
  agentDir: string
  sessionDir: string
  credentials: ResolvedCredentials
}

export type PiProfileOptions = {
  placement: RuntimePlacement
  machineOwnerUserId: string
  canUseOwnLogin: boolean
  stateRoot: string
  ownerAgentDir?: string
}

const providerPaths: Record<string, { path: string; env: readonly string[] }> = {
  anthropic: { path: "", env: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"] },
  openai: { path: "/v1", env: ["OPENAI_API_KEY"] },
  openrouter: { path: "/api", env: ["OPENROUTER_API_KEY"] },
  google: { path: "/v1beta", env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"] },
  groq: { path: "/openai/v1", env: ["GROQ_API_KEY"] },
  xai: { path: "/v1", env: ["XAI_API_KEY"] },
}

function ownerOrigin(origin: TurnOrigin, options: PiProfileOptions): boolean {
  const actor = origin.actor
  return (actor.kind === "machine-owner" || actor.userId === options.machineOwnerUserId)
    && (origin.via === "loopback" || origin.via === "owner-grant")
    && options.canUseOwnLogin && (options.placement === "desktop" || options.placement === "loopback")
}

export function selectPiProfile(
  origin: TurnOrigin, credentials: ResolvedCredentials, directory: string, sessionId: string, options: PiProfileOptions,
  sessionProfile?: CredentialProfile,
): PiProfile {
  const kind = sessionProfile ?? (ownerOrigin(origin, options) ? "owner-login" : "brokered")
  const selected = selectTurnCredentials({
    origin, placement: options.placement, machineOwnerUserId: options.machineOwnerUserId,
    canUseOwnLogin: options.canUseOwnLogin,
    profile: { kind: "pi-rpc", sessionProfile: kind, ownerLogin: credentials, brokeredCredentials: credentials },
  })
  const workspace = createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 16)
  const stateDir = path.join(options.stateRoot, workspace)
  const session = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
  return {
    kind,
    credentials: selected,
    agentDir: kind === "owner-login" ? options.ownerAgentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent") : path.join(stateDir, "profiles", session),
    sessionDir: path.join(stateDir, "sessions", session),
  }
}

export function piEnvironment(profile: PiProfile, base: NodeJS.ProcessEnv): Record<string, string> {
  const env = Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  if (profile.kind === "brokered") {
    for (const provider of Object.values(providerPaths)) for (const name of provider.env) delete env[name]
  }
  env.PI_CODING_AGENT_DIR = profile.agentDir
  return env
}

export function piProjectionArgs(projection: PluginProjection): string[] {
  if (projection.mcpServers.length) throw new Error("Pi has no MCP intake")
  return projection.pluginRoots.flatMap(({ root }) => ["-e", path.resolve(root)])
}

export async function preparePiProfile(profile: PiProfile, model?: PromptModel): Promise<void> {
  await fs.mkdir(profile.sessionDir, { recursive: true, mode: 0o700 })
  if (profile.kind === "owner-login") return
  await fs.mkdir(profile.agentDir, { recursive: true, mode: 0o700 })
  const providers: Record<string, { baseUrl: string; apiKey: string }> = {}
  const selected = model?.providerID === "pi" ? model.modelID.split("/", 1)[0] : undefined
  for (const [name, config] of Object.entries(providerPaths)) {
    const projection = piCredentialProviderIDs(name).map((id) => profile.credentials.providers[id]).find(Boolean)
    if (!projection) continue
    if ("unavailable" in projection) {
      if (!selected || selected === name) throw new Error(`Pi provider ${name} unavailable: ${projection.reason}`)
      continue
    }
    providers[name] = { baseUrl: `${projection.baseUrl}${config.path}`, apiKey: projection.placeholder }
  }
  const target = path.join(profile.agentDir, "models.json")
  const temp = `${target}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify({ providers }), { mode: 0o600 })
  await fs.rename(temp, target)
}
