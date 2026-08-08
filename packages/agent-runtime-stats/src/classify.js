import { commandFrom, shellSegments, shellWords } from "./command.js"

// Node-hosted just-bash manifest. Network is assumed configured and allowlisted.
// Commands that execute generated code are deliberately excluded by product policy.
const JUST_BASH_COMMANDS = new Set([
  "alias",
  "awk",
  "base64",
  "basename",
  "bash",
  "cat",
  "cd",
  "chmod",
  "clear",
  "column",
  "comm",
  "cp",
  "curl",
  "cut",
  "date",
  "diff",
  "dirname",
  "du",
  "echo",
  "egrep",
  "env",
  "expand",
  "export",
  "expr",
  "false",
  "fgrep",
  "file",
  "find",
  "fold",
  "grep",
  "gunzip",
  "gzip",
  "head",
  "help",
  "history",
  "hostname",
  "html-to-markdown",
  "join",
  "jq",
  "ln",
  "ls",
  "md5sum",
  "mkdir",
  "mv",
  "nl",
  "od",
  "paste",
  "printenv",
  "printf",
  "pwd",
  "readlink",
  "rev",
  "rg",
  "rm",
  "rmdir",
  "sed",
  "seq",
  "sh",
  "sha1sum",
  "sha256sum",
  "sleep",
  "sort",
  "split",
  "sqlite3",
  "stat",
  "strings",
  "tac",
  "tail",
  "tar",
  "tee",
  "test",
  "time",
  "timeout",
  "touch",
  "tr",
  "tree",
  "true",
  "unalias",
  "unexpand",
  "uniq",
  "wc",
  "which",
  "whoami",
  "xan",
  "xargs",
  "yq",
  "zcat",
])

const GENERATED_CODE_COMMANDS = new Set([
  ".",
  "bun",
  "cargo",
  "cc",
  "clang",
  "deno",
  "dotnet",
  "eval",
  "g++",
  "gcc",
  "go",
  "java",
  "javac",
  "js-exec",
  "lua",
  "node",
  "perl",
  "php",
  "python",
  "python3",
  "ruby",
  "rustc",
  "swift",
  "source",
  "ts-node",
  "tsx",
])
const DEV_RUNNERS = new Set(["bunx", "gradle", "make", "mvn", "npm", "npx", "pnpm", "pytest", "uv", "yarn"])
const BROWSERS = new Set(["agent-browser", "browser-use", "chrome", "chromium", "cypress", "playwright", "puppeteer"])
const PROCESS_COMMANDS = new Set(["kill", "killall", "launchctl", "lsof", "pgrep", "pkill", "ps", "systemctl"])
const SHELL_KEYWORDS = new Set(["!", "do", "elif", "else", "if", "then", "until", "while", "{"])

const CONTROL_NAMES = new Set([
  "agent",
  "ask_user_question",
  "automation_update",
  "close_agent",
  "create_goal",
  "create_thread",
  "exit_plan_mode",
  "enter_plan_mode",
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
  "question",
  "read_thread",
  "read_thread_terminal",
  "request_user_input",
  "resume_agent",
  "send_message",
  "send_message_to_thread",
  "structured_output",
  "skill",
  "task",
  "todo_write",
  "todowrite",
  "update_goal",
  "update_plan",
  "wait",
  "wait_agent",
  "wait_threads",
])
const CONTROL_PREFIXES = ["set_thread_", "task_"]
const FILE_TOOL_NAMES = ["apply_patch", "edit", "glob", "grep", "list", "patch", "read", "replace", "search", "write"]
const CAPABILITY_TOOL_NAMES = ["context7", "doc", "fetch", "http", "image", "mcp", "search_web", "web_search"]
const VM_TOOL_NAMES = ["browser", "computer", "playwright", "puppeteer"]
const GENERATED_CODE_TOOL_NAMES = ["code_interpreter", "execute_code", "javascript", "js", "python", "python_repl"]
const SHELL_TOOL_NAMES = new Set(["bash", "exec_command", "run_shell_command", "shell", "terminal"])
const EXEC_CAPABILITIES = ["tools.view_image(", "tools.web__", "tools.mcp__", "tools.image_gen__", "tools.query_docs"]

function result(tier, bucket) {
  return { tier, bucket }
}

function normalizeName(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll("-", "_")
}

function matchesToolName(name, candidate) {
  return (
    name === candidate ||
    name.startsWith(`${candidate}_`) ||
    name.endsWith(`_${candidate}`) ||
    name.includes(`_${candidate}_`)
  )
}

function combine(classifications) {
  return (
    classifications.find((classification) => classification.tier === "vm") ??
    classifications.find((classification) => classification.tier === "unknown") ??
    result("bash", "files / shell utilities")
  )
}

function executableFrom(segment) {
  const parsed = shellWords(segment)
  if (!parsed.complete) return null
  const words = parsed.words
  let index = 0
  while (index < words.length) {
    const rawWord = words[index]
    const word = rawWord.replace(/^[({]+/, "").replace(/[)}]+$/, "")
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && word.includes("$(")) return null
    if (SHELL_KEYWORDS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || /^\d*(?:<|>)/.test(word)) {
      index++
      continue
    }
    if (["for", "case", "function", "in", "select"].includes(word)) {
      return { executable: null, arguments: [], localPath: false }
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\(\)$/.test(word)) {
      index++
      continue
    }
    if (word === "env") {
      index++
      while (index < words.length) {
        const argument = words[index]
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) index++
        else if (["-u", "--unset", "-C", "--chdir"].includes(argument)) index += 2
        else if (argument.startsWith("--unset=") || argument.startsWith("--chdir=") || argument.startsWith("-")) index++
        else break
      }
      continue
    }
    if (word === "timeout") {
      index++
      while (index < words.length && words[index].startsWith("-")) {
        index += ["-k", "--kill-after", "-s", "--signal"].includes(words[index]) ? 2 : 1
      }
      if (index < words.length && /^\d+(?:\.\d+)?[smhd]?$/.test(words[index])) index++
      continue
    }
    if (word === "time") {
      index++
      while (index < words.length && words[index].startsWith("-")) index++
      continue
    }
    if (word === "command") {
      if (words.slice(index + 1).some((argument) => argument === "-v" || argument === "-V")) {
        return { executable: null, arguments: [], localPath: false }
      }
      index++
      while (index < words.length && words[index].startsWith("-")) index++
      continue
    }
    if (word === "builtin" || word === "exec") {
      index++
      while (index < words.length && words[index].startsWith("-")) index++
      continue
    }
    if (word.startsWith("$") || word.includes("$(")) return null
    return { executable: word.toLowerCase(), arguments: words.slice(index + 1), localPath: word.includes("/") }
  }
  return { executable: null, arguments: [], localPath: false }
}

function classifyExecutable(command) {
  if (command === null) return result("unknown", "dynamic / unresolved command")
  if (command.executable === null) return result("bash", "shell syntax / comment")
  const executable = command.localPath ? command.executable.split("/").pop() : command.executable
  if (command.localPath) return result("vm", "generated code execution*")
  if (BROWSERS.has(executable)) return result("vm", "browser testing")
  if (GENERATED_CODE_COMMANDS.has(executable)) return result("vm", "generated code execution*")
  if (DEV_RUNNERS.has(executable)) return result("vm", "dev runner / package scripts")
  if (executable === "git") return result("vm", "Git repository operations")
  if (executable === "gh") {
    return command.arguments[0] === "api"
      ? result("bash", "configured network / API request")
      : result("vm", "Git repository operations")
  }
  if (PROCESS_COMMANDS.has(executable)) return result("vm", "interactive / OS process")
  if (executable === "xargs") {
    const optionsWithValues = new Set([
      "-a",
      "--arg-file",
      "-E",
      "--eof",
      "-I",
      "--replace",
      "-L",
      "--max-lines",
      "-n",
      "--max-args",
      "-P",
      "--max-procs",
      "-s",
      "--max-chars",
      "--process-slot-var",
    ])
    let index = 0
    while (index < command.arguments.length) {
      const argument = command.arguments[index]
      if (optionsWithValues.has(argument)) index += 2
      else if (argument === "--") {
        index++
        break
      } else if (argument.startsWith("-")) index++
      else break
    }
    const nested = command.arguments[index]
    return nested
      ? classifyExecutable({ executable: nested.toLowerCase(), arguments: [], localPath: nested.includes("/") })
      : result("bash", "files / shell utilities")
  }
  if (executable === "[") return result("bash", "files / shell utilities")
  if (JUST_BASH_COMMANDS.has(executable)) {
    if (
      (executable === "bash" || executable === "sh") &&
      command.arguments.some((argument) => !argument.startsWith("-"))
    ) {
      return result("vm", "generated code execution*")
    }
    return result(
      "bash",
      executable === "curl" || executable === "html-to-markdown"
        ? "configured network / API request"
        : "files / shell utilities",
    )
  }
  return result("vm", "OS / native / local executable")
}

function classifyCommand(command) {
  const nested = []
  const withoutSubstitutions = command
    .replace(/\$\(([^()]*)\)/g, (_match, inner) => {
      nested.push(classifyCommand(inner))
      return "substitution"
    })
    .replace(/`([^`]*)`/g, (_match, inner) => {
      nested.push(classifyCommand(inner))
      return "substitution"
    })
  const parsed = shellSegments(withoutSubstitutions)
  if (!parsed.complete || !parsed.segments.length) return result("unknown", "dynamic / unresolved command")
  return combine([...parsed.segments.map((segment) => classifyExecutable(executableFrom(segment))), ...nested])
}

function embeddedCommands(program) {
  const commands = []
  const expression = /\b(?:cmd|command)\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g
  for (const match of program.matchAll(expression)) {
    let value = match[2]
    if (match[1] === '"') {
      try {
        value = JSON.parse(`"${value}"`)
      } catch {}
    } else value = value.replaceAll(`\\${match[1]}`, match[1]).replaceAll("\\n", "\n")
    commands.push(value)
  }
  return commands
}

function classifyCodemode(program) {
  const classifications = []
  if (program.includes("tools.write_stdin(") || program.includes("tools.send_input(")) {
    classifications.push(result("vm", "interactive / OS process"))
  }
  if (program.includes("tools.exec_command(")) {
    const commands = embeddedCommands(program)
    if (commands.length) classifications.push(...commands.map(classifyCommand))
    else classifications.push(result("unknown", "dynamic / unresolved command"))
  }
  if (program.includes("tools.apply_patch(")) classifications.push(result("bash", "files / shell utilities"))
  if (EXEC_CAPABILITIES.some((value) => program.includes(value))) {
    classifications.push(result("bash", "configured capability"))
  }
  return classifications.length ? combine(classifications) : result("unknown", "unrecognized codemode program")
}

export function classifyToolCall(call) {
  const name = normalizeName(call.name)
  if (CONTROL_NAMES.has(name) || CONTROL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return result("control", "orchestration")
  }
  if (name === "exec") {
    const program = commandFrom(call.input)
    return call.harness === "codex" || program.includes("tools.") ? classifyCodemode(program) : classifyCommand(program)
  }
  if (name === "send_input" || name === "write_stdin") return result("vm", "interactive / OS process")
  if (GENERATED_CODE_TOOL_NAMES.some((value) => matchesToolName(name, value))) {
    return result("vm", "generated code execution*")
  }
  if (VM_TOOL_NAMES.some((value) => matchesToolName(name, value))) return result("vm", "browser testing")
  if (CAPABILITY_TOOL_NAMES.some((value) => matchesToolName(name, value))) {
    return result("bash", "configured capability")
  }
  if (FILE_TOOL_NAMES.some((value) => matchesToolName(name, value))) return result("bash", "files / shell utilities")
  if (SHELL_TOOL_NAMES.has(name)) {
    const command = commandFrom(call.input)
    return command ? classifyCommand(command) : result("unknown", "missing shell command")
  }
  const command = commandFrom(call.input)
  return command ? classifyCommand(command) : result("unknown", "unrecognized tool")
}
