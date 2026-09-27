import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { PI_LAUNCH_PROVIDERS, piCredentialProviderIDs, type PromptModel } from "@claxedo/agent-runtime-contract"
import type { MachineLoginPolicy, PluginProjection, ResolvedCredentials, TurnActor } from "../../contract"
import type { CredentialProfile } from "../../registry/credentials"
import { ownerMayUseMachineLogin, providerPlaceholder, selectedProviderProjection } from "../../contract"
import { stringRecord } from "@claxedo/helpers"
import { writePrivateFileAtomic } from "@claxedo/helpers/fs"

export type PiProfile = {
  kind: CredentialProfile
  agentDir: string
  sessionDir: string
  credentials: ResolvedCredentials
}

export type PiProfileOptions = MachineLoginPolicy & {
  stateRoot: string
  ownerAgentDir: string
}

const providerEnvironment = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY",
  "OPENROUTER_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "XAI_API_KEY",
] as const

export function selectPiProfile(
  owner: TurnActor, credentials: ResolvedCredentials, directory: string, sessionId: string, options: PiProfileOptions,
  sessionProfile?: CredentialProfile,
): PiProfile {
  const kind = ownerMayUseMachineLogin(owner, options) ? sessionProfile ?? "owner-login" : "brokered"
  const workspace = createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 16)
  const stateDir = path.join(options.stateRoot, workspace)
  const session = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
  return {
    kind,
    credentials,
    agentDir: kind === "owner-login" ? options.ownerAgentDir : path.join(stateDir, "profiles", session),
    sessionDir: path.join(stateDir, "sessions", session),
  }
}

export function piEnvironment(profile: PiProfile, base: NodeJS.ProcessEnv): Record<string, string> {
  const env = stringRecord(base)
  if (profile.kind === "brokered") {
    for (const name of providerEnvironment) delete env[name]
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
  for (const name of PI_LAUNCH_PROVIDERS) {
    const projection = selectedProviderProjection(profile.credentials, piCredentialProviderIDs(name))
    if (!projection) continue
    const credential = providerPlaceholder(projection)
    if ("unavailable" in credential) {
      if (!selected || selected === name) throw new Error(`Pi provider ${name} unavailable: ${credential.reason}`)
      continue
    }
    providers[name] = { baseUrl: credential.baseURL, apiKey: credential.apiKey }
  }
  const target = path.join(profile.agentDir, "models.json")
  await writePrivateFileAtomic(target, JSON.stringify({ providers }))
}
