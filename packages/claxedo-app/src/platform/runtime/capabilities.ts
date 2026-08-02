export type SessionTransportCapabilities = {
  transport: "claude-acp" | "codex-acp" | "cursor-acp" | "claude-sdk" | "codex-app-server" | "opencode"
  abort: boolean
  reconnect: boolean
  replay: boolean
  permissions: boolean
  questions: boolean
  todos: boolean
  commands: boolean
  fork: boolean
  revert: boolean
  unrevert: boolean
  configOptions: boolean
}
