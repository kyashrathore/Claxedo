import path from "node:path"
import type { DraftLaunch, StartInput } from "../../contract"
import { claudePlugins, composeClaudeConfigHome } from "../../profiles/claude-code"
import { claudeBinding, claudeEnvironment } from "./credentials"

export type ClaudeSdkOptions = { executable: string; configRoot: string; userConfigRoot: string; env: NodeJS.ProcessEnv }

export async function claudeLaunchContext(input: StartInput | DraftLaunch, options: ClaudeSdkOptions, sessionId: string) {
  const binding = claudeBinding(input.credentials, input.owner)
  const home = binding ? await composeClaudeConfigHome(path.join(options.configRoot, sessionId), options.userConfigRoot) : undefined
  return { cwd: input.directory, pathToClaudeCodeExecutable: options.executable,
    env: { ...claudeEnvironment(options.env, binding, home), CLAUDE_AGENT_SDK_CLIENT_APP: "claxedo-workspace-runtime/0.1.0",
      CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", CLAUDE_CODE_ENABLE_TASKS: "1" },
    settingSources: ["user", "project", "local"] as Array<"user" | "project" | "local">, plugins: claudePlugins(input.projection) }
}
