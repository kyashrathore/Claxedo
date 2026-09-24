import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type CliName = "claude" | "codex"

export type CliAvailability =
  | { available: true; path: string; version: string }
  | { available: false; reason: string }

const CLI_OVERRIDE_ENV: Record<CliName, string> = {
  claude: "CLAXEDO_E2E_CLAUDE_BIN",
  codex: "CLAXEDO_E2E_CODEX_BIN",
}

export async function installedCli(name: CliName): Promise<CliAvailability> {
  const binary = process.env[CLI_OVERRIDE_ENV[name]]?.trim() || name
  try {
    const resolved = binary.includes("/") ? binary : (await execFileAsync("which", [binary])).stdout.trim()
    if (!resolved) return { available: false, reason: `${name} is not on PATH` }
    const version = (await execFileAsync(resolved, ["--version"], { timeout: 10_000 })).stdout.trim()
    return { available: true, path: resolved, version }
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error)
    return { available: false, reason: `${name} is not installed or does not run (${detail})` }
  }
}

export function claudeScriptedEnv(url: string, configDir: string) {
  return {
    ANTHROPIC_BASE_URL: url,
    CLAUDE_CODE_API_BASE_URL: url,
    ANTHROPIC_API_KEY: "test-key",
    ANTHROPIC_AUTH_TOKEN: "test-key",
    CLAUDE_CODE_OAUTH_TOKEN: "test-key",
    CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: configDir,
  }
}

export function codexScriptedConfigJson(v1Url: string) {
  return JSON.stringify({
    model_provider: "scripted",
    features: {
      multi_agent: true,
      multi_agent_v2: { enabled: true, non_code_mode_only: true, tool_namespace: "agents" },
    },
    model_providers: {
      scripted: {
        name: "scripted",
        base_url: v1Url,
        wire_api: "responses",
        env_key: "OPENAI_API_KEY",
        requires_openai_auth: false,
      },
    },
  })
}

export function codexScriptedConfigToml(v1Url: string, model = "gpt-5.6-sol") {
  return `model_provider = "scripted"
model = "${model}"

[features]
multi_agent = true

[features.multi_agent_v2]
enabled = true
non_code_mode_only = true
tool_namespace = "agents"

[model_providers.scripted]
name = "scripted"
base_url = "${v1Url}"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
requires_openai_auth = false
`
}

export function piModelsJson(v1Url: string) {
  return JSON.stringify({
    providers: {
      openai: {
        baseUrl: v1Url,
        api: "openai-completions",
        apiKey: "test-key",
        models: [{ id: "gpt-4.1", input: ["text", "image"], reasoning: false, contextWindow: 32000, maxTokens: 4096 }],
      },
    },
  })
}

export function piSettingsJson() {
  return JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4.1" })
}
