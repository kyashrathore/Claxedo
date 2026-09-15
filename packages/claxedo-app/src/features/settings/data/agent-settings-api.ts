import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { readBoolean, readField, readString } from "@/lib/record"

/** "Agents may act on my other machines": whether an agent in a session may start tasks on new cloud machines. */
export type AgentSettings = { crossMachineWrites: boolean }

export type AgentSettingsApi = {
  read(): Promise<AgentSettings>
  write(settings: AgentSettings): Promise<AgentSettings>
}

const PATH = "/api/account/agent-settings"

async function call(init?: RequestInit): Promise<AgentSettings> {
  const headers = new Headers(init?.headers)
  headers.set("accept", "application/json")
  const response = await authFetch(new URL(PATH, getClaxedoServerUrl()).toString(), {
    credentials: "include",
    ...init,
    headers,
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new Error(readString(readField(body, "error"), "message") ?? "Agent settings are unavailable")
  }
  const crossMachineWrites = readBoolean(body, "cross_machine_writes")
  if (crossMachineWrites === undefined) throw new Error("Agent settings are unavailable")
  return { crossMachineWrites }
}

export function readAgentSettings(): Promise<AgentSettings> {
  return call()
}

export function writeAgentSettings(settings: AgentSettings): Promise<AgentSettings> {
  return call({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cross_machine_writes: settings.crossMachineWrites }),
  })
}

export const agentSettingsApi: AgentSettingsApi = { read: readAgentSettings, write: writeAgentSettings }
