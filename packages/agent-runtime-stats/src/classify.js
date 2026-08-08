const DEV_RUNNERS = new Set(["bun", "bunx", "deno", "node", "npm", "npx", "pnpm", "yarn"])
const BROWSERS = new Set(["agent-browser", "browser-use", "chrome", "chromium", "cypress", "playwright", "puppeteer"])
const NETWORK_ONLY = new Set(["curl", "wget"])
const NATIVE = new Set([
  "adb",
  "brew",
  "cargo",
  "clang",
  "cmake",
  "docker",
  "ffmpeg",
  "g++",
  "gcc",
  "go",
  "gradle",
  "java",
  "javac",
  "kill",
  "killall",
  "launchctl",
  "lsof",
  "make",
  "mvn",
  "perl",
  "pip",
  "pip3",
  "pkill",
  "podman",
  "ps",
  "pytest",
  "python",
  "python3",
  "ruby",
  "rustc",
  "sqlite3",
  "swift",
  "unzip",
  "uv",
  "xcodebuild",
  "zip",
])
const CONTROL_PREFIXES = [
  "automation_update",
  "close_agent",
  "create_goal",
  "create_thread",
  "followup_task",
  "fork_thread",
  "get_goal",
  "handoff_thread",
  "interrupt_agent",
  "list_agents",
  "list_projects",
  "list_threads",
  "load_workspace_dependencies",
  "navigate_to_codex_page",
  "open_in_codex",
  "read_thread",
  "read_thread_terminal",
  "request_user_input",
  "resume_agent",
  "send_message",
  "send_message_to_thread",
  "set_thread_",
  "spawn_agent",
  "update_goal",
  "update_plan",
  "wait",
  "wait_agent",
  "wait_threads",
]
const EXEC_HOST_BINDINGS = ["tools.view_image(", "tools.web__", "tools.mcp__", "tools.image_gen__", "tools.query_docs"]
const VM_TOOL_NAMES = ["browser", "computer", "playwright", "puppeteer"]
const LIGHTWEIGHT_TOOL_NAMES = [
  "context7",
  "doc",
  "fetch",
  "http",
  "image",
  "javascript",
  "mcp",
  "search_web",
  "web_search",
]
const SHELL_LIKE_NAMES = [
  "apply_patch",
  "edit",
  "glob",
  "grep",
  "list",
  "patch",
  "read",
  "replace",
  "search",
  "shell",
  "terminal",
  "write",
]
const SHELL_NAMES = new Set(["bash", "exec_command", "run_shell_command"])

function result(tier, bucket) {
  return { tier, bucket }
}

function matchesToolName(name, candidate) {
  return (
    name === candidate ||
    name.startsWith(`${candidate}_`) ||
    name.endsWith(`_${candidate}`) ||
    name.includes(`_${candidate}_`)
  )
}

function commandFrom(input) {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input)
      if (parsed !== input) return commandFrom(parsed)
    } catch {}
    const embedded = input.match(/\b(?:cmd|command)\s*[:=]\s*["'`]([^"'`]*)["'`]/s)
    return embedded ? embedded[1].replaceAll("\\n", "\n").replaceAll('\\"', '"') : input
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const key of ["command", "cmd", "script", "code"]) {
      if (typeof input[key] === "string") return input[key]
    }
    return commandFrom(input.input)
  }
  return ""
}

function classifyCommand(command) {
  const words = command.match(/[A-Za-z0-9_+.-]+/g) ?? []
  const normalizedWords = words.map((word) => word.toLowerCase())
  let browser = false
  let devRunner = false
  let git = false
  let networkOnly = false
  let native = false
  for (const normalized of normalizedWords) {
    browser ||= BROWSERS.has(normalized)
    devRunner ||= DEV_RUNNERS.has(normalized)
    git ||= normalized === "git"
    networkOnly ||= NETWORK_ONLY.has(normalized)
    native ||= NATIVE.has(normalized)
  }
  const hasFly = normalizedWords.includes("fly")
  const ghPositions = normalizedWords.flatMap((word, index) => (word === "gh" ? [index] : []))
  const ghOnlyUsesApi = ghPositions.every((index) => normalizedWords[index + 1] === "api")
  if (browser) return result("vm", "browser testing")
  if (devRunner) return result("vm", "dev runner / package scripts")
  if (git) return result("vm", "Git repository operations")
  if (native || command.split(/\s+/).some((word) => word.startsWith("./"))) {
    return result("vm", "OS / native / local executable")
  }
  if (hasFly || !ghOnlyUsesApi) {
    return result("vm", "OS / native / local executable")
  }
  if (networkOnly || ghPositions.length) return result("bash", "configured network request")
  return result("bash", "files / shell utilities")
}

export function classifyToolCall(call) {
  const name = call.name.toLowerCase().replaceAll("-", "_")
  if (CONTROL_PREFIXES.some((prefix) => name.startsWith(prefix))) return result("control", "orchestration")
  if (name === "exec" && typeof call.input === "string") {
    if (call.input.includes("tools.write_stdin(") || call.input.includes("tools.send_input(")) {
      return result("vm", "interactive process")
    }
    if (call.input.includes("tools.exec_command(")) return classifyCommand(commandFrom(call.input))
    if (call.input.includes("tools.apply_patch(")) return result("bash", "files / shell utilities")
    if (EXEC_HOST_BINDINGS.some((value) => call.input.includes(value))) {
      return result("bash", "configured capability")
    }
  }
  if (name === "send_input" || name === "write_stdin") return result("vm", "interactive process")
  if (VM_TOOL_NAMES.some((value) => matchesToolName(name, value))) {
    return result("vm", "browser testing")
  }
  const command = commandFrom(call.input)
  if (command) return classifyCommand(command)
  if (LIGHTWEIGHT_TOOL_NAMES.some((value) => matchesToolName(name, value))) {
    return result(
      "bash",
      name.includes("js") || name.includes("javascript") ? "configured JavaScript" : "configured capability",
    )
  }
  if (SHELL_LIKE_NAMES.some((value) => matchesToolName(name, value)) || SHELL_NAMES.has(name)) {
    return classifyCommand(command)
  }
  return result("bash", "configured capability")
}
