import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { execFileSync } from "child_process"
import { tmpdir } from "os"
import path from "path"
import {
  buildWrapperScript,
  generateClaudeWrapper,
  generateCodexWrapper,
  generatePassthroughWrapper,
  generateGenericWrapper,
  generateOpenCodeWrapper,
  generateCopilotWrapper,
  normalizeWrappers,
} from "./wrappers"
import { WRAPPER_MARKER } from "./constants"

const TEST_ROOT = path.join(tmpdir(), `claxedo-wrappers-test-${process.pid}-${Date.now()}`)

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe("buildWrapperScript", () => {
  it("includes marker, find_real_binary, binary name, and exec block", () => {
    const script = buildWrapperScript("myagent", `exec "$REAL_BIN" "$@"`)

    expect(script).toContain(WRAPPER_MARKER)
    expect(script).toContain("find_real_binary")
    expect(script).toContain('find_real_binary "myagent"')
    expect(script).toContain("Claxedo: myagent not found in PATH")
    expect(script).toContain('exec "$REAL_BIN" "$@"')
    expect(script).toContain('export CLAXEDO_AGENT="myagent"')
  })

  it("starts with shebang", () => {
    const script = buildWrapperScript("test", "exec true")
    expect(script.startsWith("#!/bin/bash\n")).toBe(true)
  })
})

describe("generatePassthroughWrapper", () => {
  it("creates a simple exec passthrough for the named binary", () => {
    const script = generatePassthroughWrapper("gemini")

    expect(script).toContain(WRAPPER_MARKER)
    expect(script).toContain('find_real_binary "gemini"')
    expect(script).toContain('exec "$REAL_BIN" "$@"')
    expect(script).toContain('export CLAXEDO_AGENT="gemini"')
  })

  for (const agent of ["droid", "amp", "mastracode", "cursor-agent"]) {
    it(`creates passthrough for ${agent}`, () => {
      const script = generatePassthroughWrapper(agent)
      expect(script).toContain(`find_real_binary "${agent}"`)
      expect(script).toContain('exec "$REAL_BIN" "$@"')
    })
  }
})

describe("generateClaudeWrapper", () => {
  it("includes exit trap for idle/error notification", () => {
    const script = generateClaudeWrapper("/tmp/hooks/notify.sh")

    expect(script).toContain("trap cleanup EXIT")
    expect(script).toContain('hook_event_name":"Idle"')
    expect(script).toContain('hook_event_name":"Error"')
    expect(script).toContain('find_real_binary "claude"')
  })
})

describe("generateCodexWrapper", () => {
  it("renders legacy codex wrapper with log watcher + notify bridge", () => {
    const script = generateCodexWrapper({
      notifyPath: "/tmp/hooks/codex-notify.sh",
      watcherPath: "/tmp/hooks/codex-watcher.sh",
      native: false,
    })

    expect(script).toContain(".codex-watch.pid")
    expect(script).toContain(".codex-turn")
    expect(script).toContain("/tmp/hooks/codex-watcher.sh")
    expect(script).toContain("/tmp/hooks/codex-notify.sh")
    expect(script).toContain('notify=["bash","/tmp/hooks/codex-notify.sh"]')
  })

  it("renders native codex wrapper with tui session log watcher", () => {
    const script = generateCodexWrapper({
      notifyPath: "/tmp/hooks/notify.sh",
      watcherPath: "/tmp/hooks/notify.sh",
      native: true,
    })

    expect(script).toContain("export CODEX_TUI_RECORD_SESSION=1")
    expect(script).toContain('"msg":{"type":"task_started"')
    expect(script).toContain('_claxedo_last_turn_id=""')
    expect(script).toContain('_claxedo_last_approval_id=""')
    expect(script).toContain('_claxedo_last_exec_call_id=""')
    expect(script).toContain("_claxedo_approval_fallback_seq=0")
    expect(script).toContain("_claxedo_emit_event()")
    expect(script).toContain('"msg":{"type":"exec_command_begin"')
    expect(script).toContain('_approval_request"')
    expect(script).toContain('_claxedo_emit_event "Start"')
    expect(script).toContain('_claxedo_emit_event "PermissionRequest"')
    expect(script).toContain("CLAXEDO_CODEX_START_WATCHER_PID")
    expect(script).toContain('kill "$CLAXEDO_CODEX_START_WATCHER_PID"')
  })
})

describe("generateOpenCodeWrapper", () => {
  it("injects OPENCODE_CONFIG_DIR", () => {
    const script = generateOpenCodeWrapper()

    expect(script).toContain("OPENCODE_CONFIG_DIR=")
    expect(script).toContain('exec "$REAL_BIN" "$@"')
    expect(script).toContain('find_real_binary "opencode"')
  })
})

describe("generateGenericWrapper", () => {
  it("sends busy/idle/error notifications around the real binary", () => {
    const script = generateGenericWrapper("aider", "/tmp/hooks/notify.sh")

    expect(script).toContain('hook_event_name":"Busy"')
    expect(script).toContain('hook_event_name":"Idle"')
    expect(script).toContain('hook_event_name":"Error"')
    expect(script).toContain('"$REAL_BIN" "$@"')
    expect(script).toContain("CLAXEDO_TAB_ID")
  })
})

describe("generateCopilotWrapper", () => {
  it("injects project-level hooks JSON and git exclude", () => {
    const script = generateCopilotWrapper("/tmp/hooks/copilot-hook.sh")

    expect(script).toContain("COPILOT_HOOKS_DIR")
    expect(script).toContain("claxedo-notify.json")
    expect(script).toContain(".git/info/exclude")
    expect(script).toContain('exec "$REAL_BIN" "$@"')
  })
})

describe("copilot wrapper integration", () => {
  it("rewrites stale hook file with current hook path", () => {
    const projectDir = path.join(TEST_ROOT, "project")
    const hooksDir = path.join(projectDir, ".github", "hooks")
    const hookFile = path.join(hooksDir, "claxedo-notify.json")
    const gitInfoDir = path.join(projectDir, ".git", "info")
    const realBinDir = path.join(TEST_ROOT, "real-bin")
    const wrapperBinDir = path.join(TEST_ROOT, "bin")
    const realCopilot = path.join(realBinDir, "copilot")
    const wrapperPath = path.join(wrapperBinDir, "copilot")
    const hookScriptPath = path.join(TEST_ROOT, "hooks", "copilot-hook.sh")

    mkdirSync(hooksDir, { recursive: true })
    mkdirSync(gitInfoDir, { recursive: true })
    mkdirSync(realBinDir, { recursive: true })
    mkdirSync(wrapperBinDir, { recursive: true })
    mkdirSync(path.dirname(hookScriptPath), { recursive: true })

    writeFileSync(hookScriptPath, "#!/bin/bash\nexit 0\n", { mode: 0o755 })
    writeFileSync(hookFile, '{"old":"stale-config"}')
    writeFileSync(realCopilot, "#!/bin/bash\necho real-copilot\n", { mode: 0o755 })
    chmodSync(realCopilot, 0o755)

    const script = generateCopilotWrapper(hookScriptPath)
    writeFileSync(wrapperPath, script, { mode: 0o755 })
    chmodSync(wrapperPath, 0o755)

    // Don't include wrapperBinDir in PATH — find_real_binary only skips
    // the real BIN_DIR, so having wrapperBinDir in PATH causes infinite recursion
    // (wrapper finds itself). The wrapper is invoked directly by full path.
    execFileSync(wrapperPath, [], {
      cwd: projectDir,
      env: {
        ...process.env,
        PATH: `${realBinDir}:${process.env.PATH || ""}`,
        CLAXEDO_TAB_ID: "tab-1",
      },
      encoding: "utf-8",
    })

    const updated = readFileSync(hookFile, "utf-8")
    expect(updated).toContain(hookScriptPath)
    expect(updated).not.toContain("stale-config")
  })
})

describe("codex wrapper integration", () => {
  it("forwards notify hook config through the wrapper", () => {
    const realBinDir = path.join(TEST_ROOT, "real-bin")
    const wrapperBinDir = path.join(TEST_ROOT, "bin")
    const realCodex = path.join(realBinDir, "codex")
    const wrapperPath = path.join(wrapperBinDir, "codex")
    const argsFile = path.join(TEST_ROOT, "codex-args.txt")
    const notifyPath = path.join(TEST_ROOT, "hooks", "notify.sh")

    mkdirSync(realBinDir, { recursive: true })
    mkdirSync(wrapperBinDir, { recursive: true })
    mkdirSync(path.dirname(notifyPath), { recursive: true })
    writeFileSync(notifyPath, "#!/bin/bash\nexit 0\n", { mode: 0o755 })

    writeFileSync(
      realCodex,
      `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 0\n`,
      { mode: 0o755 },
    )
    chmodSync(realCodex, 0o755)

    const script = generateCodexWrapper({
      notifyPath,
      watcherPath: notifyPath,
      native: true,
    })
    writeFileSync(wrapperPath, script, { mode: 0o755 })
    chmodSync(wrapperPath, 0o755)

    // Don't include wrapperBinDir in PATH (find_real_binary would find
    // the wrapper itself → infinite recursion). Also omit CLAXEDO_TAB_ID
    // to skip the background session-log watcher which holds stdout pipes open.
    execFileSync(wrapperPath, ["exec", "Reply with exactly OK."], {
      env: {
        ...process.env,
        PATH: `${realBinDir}:${process.env.PATH || ""}`,
      },
      encoding: "utf-8",
    })

    const args = readFileSync(argsFile, "utf-8")
    expect(args).toContain(notifyPath)
    expect(args).toContain("exec")
    expect(args).toContain("Reply with exactly OK.")
  })
})

describe("normalizeWrappers", () => {
  it("deduplicates and lowercases", () => {
    expect(normalizeWrappers(["FOO", "foo", "bar"])).toEqual(["foo", "bar"])
  })

  it("rejects invalid names", () => {
    expect(normalizeWrappers(["valid", "INVALID SPACE", ".starts-dot", "ok-name"])).toEqual(["valid", "ok-name"])
  })

  it("limits to 48 entries", () => {
    const many = Array.from({ length: 60 }, (_, i) => `agent${i}`)
    expect(normalizeWrappers(many).length).toBe(48)
  })
})
