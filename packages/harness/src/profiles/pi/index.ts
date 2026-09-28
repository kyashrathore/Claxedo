import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { PI_LAUNCH_PROVIDERS, piCredentialProviderIDs, type PromptModel } from "@claxedo/agent-runtime-contract"
import type { MachineLoginPolicy, PluginProjection, ResolvedCredentials } from "../../contract"
import type { CredentialProfile } from "../../registry/credentials"
import { providerPlaceholder, selectedProviderProjection } from "../../contract"
import { stringRecord } from "@claxedo/helpers"
import { isMissingFile, writePrivateFileAtomic } from "@claxedo/helpers/fs"

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

const OWNER_PROBE_FILES = ["settings.json", "auth.json", "models.json", "trust.json"] as const
const EXTENSION_ENTRY_FILES = ["index.ts", "index.js", "package.json"] as const

export function selectPiProfile(
  credentials: ResolvedCredentials, directory: string, sessionId: string, options: PiProfileOptions,
  sessionProfile?: CredentialProfile,
): PiProfile {
  const machineLogin = credentials.machineLoginAllowed
  const bound = PI_LAUNCH_PROVIDERS.some((name) => selectedProviderProjection(credentials, piCredentialProviderIDs(name)) !== undefined)
  const kind = machineLogin ? sessionProfile ?? (bound ? "brokered" : "owner-login") : "brokered"
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

async function extensionInputs(folder: string): Promise<string[]> {
  let entries: Dirent[]
  try { entries = await fs.readdir(folder, { withFileTypes: true }) }
  catch (error) {
    if (isMissingFile(error) || (error instanceof Error && "code" in error && error.code === "ENOTDIR")) return [folder]
    throw error
  }
  return [folder, ...entries.flatMap((entry) => entry.isDirectory()
    ? EXTENSION_ENTRY_FILES.map((name) => path.join(folder, entry.name, name)) : [path.join(folder, entry.name)])]
}

function projectFolders(directory: string): string[] {
  const folders: string[] = []
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    folders.push(path.join(current, ".pi"))
    if (path.dirname(current) === current) return folders
  }
}

export async function piProbeInputs(profile: PiProfile, directory: string): Promise<string[]> {
  const owner = profile.kind === "owner-login"
    ? [...OWNER_PROBE_FILES.map((name) => path.join(profile.agentDir, name)), ...await extensionInputs(path.join(profile.agentDir, "extensions"))] : []
  return [...owner, ...projectFolders(directory).flatMap((folder) => [folder, path.join(folder, "settings.json")]),
    ...await extensionInputs(path.join(path.resolve(directory), ".pi", "extensions"))]
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
