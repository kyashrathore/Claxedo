import { wrapper, argumentsFor } from "../test-support/status-hooks"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { execFileSync } from "child_process"
import { tmpdir } from "os"
import path from "path"
import { buildWrapperScript, generateGenericWrapper, normalizeWrappers } from "./core/wrappers"
import { WRAPPER_MARKER } from "./core/constants"

const TEST_ROOT = path.join(tmpdir(), `claxedo-wrappers-test-${process.pid}-${Date.now()}`)

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

// POSIX shebang execution: a wrapper is a bare bash script a POSIX shell finds on PATH, which cmd.exe never does.
const posixShebang = process.platform !== "win32"

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

describe("Claude template wrapper", () => {
  it("includes exit trap for idle/error notification", () => {
    const script = wrapper("claude", "/tmp/hooks/notify.sh")

    expect(script).toContain("trap cleanup EXIT")
    expect(script).toContain('hook_event_name":"Idle"')
    expect(script).toContain('hook_event_name":"Error"')
    expect(script).toContain('find_real_binary "claude"')
    expect(script).toContain(`"$REAL_BIN" --settings '/tmp/hooks/claude-settings.json' "$@"`)
  })
})

describe("Codex template arguments", () => {
  it("registers every lifecycle event as a session flag that runs the notify script for codex", () => {
    const flags = argumentsFor("codex", "/tmp/hooks/notify.sh")
    const events = flags.filter((_, index) => index % 2 === 1).map((flag) => flag.slice("hooks.".length, flag.indexOf("=")))
    expect(events).toEqual(["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Interrupt", "SubagentStart", "SubagentStop"])
    expect(flags.filter((_, index) => index % 2 === 0).every((flag) => flag === "-c")).toBe(true)
    expect(flags[7]).toBe(`hooks.PreToolUse=[{matcher="^request_user_input$",hooks=[{type="command",command="'/tmp/hooks/notify.sh' --harness=codex"}]}]`)
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

describe("Copilot template wrapper", () => {
  it("injects project-level hooks JSON and git exclude", () => {
    const script = wrapper("copilot", "/tmp/hooks/copilot-hook.sh".replace(/copilot-hook\.sh$/, "notify.sh"))

    expect(script).toContain("COPILOT_HOOKS_DIR")
    expect(script).toContain("claxedo-notify.json")
    expect(script).toContain(".git/info/exclude")
    expect(script).toContain('exec "$REAL_BIN" "$@"')
  })
})

describe.skipIf(!posixShebang)("copilot wrapper integration", () => {
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

    const script = wrapper("copilot", hookScriptPath.replace(/copilot-hook\.sh$/, "notify.sh"))
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

describe.skipIf(!posixShebang)("copilot project hooks", () => {
  function copilotProject() {
    const projectDir = path.join(TEST_ROOT, "copilot-project")
    const realBinDir = path.join(TEST_ROOT, "copilot-real-bin")
    const wrapperPath = path.join(TEST_ROOT, "copilot-bin", "copilot")
    const hookScriptPath = path.join(TEST_ROOT, "copilot-hooks", "copilot-hook.sh")
    for (const dir of [path.join(projectDir, ".git", "info"), path.join(projectDir, ".github", "hooks"), realBinDir, path.dirname(wrapperPath), path.dirname(hookScriptPath)]) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(hookScriptPath, "#!/bin/bash\nexit 0\n", { mode: 0o755 })
    writeFileSync(path.join(realBinDir, "copilot"), "#!/bin/bash\nexit 0\n", { mode: 0o755 })
    writeFileSync(wrapperPath, wrapper("copilot", hookScriptPath.replace(/copilot-hook\.sh$/, "notify.sh")), { mode: 0o755 })
    const run = (tab: string) => execFileSync(wrapperPath, [], {
      cwd: projectDir, env: { ...process.env, PATH: `${realBinDir}:${process.env.PATH || ""}`, CLAXEDO_TAB_ID: tab }, encoding: "utf-8",
    })
    return { projectDir, run }
  }

  it("adds its exclude line once, keeps the person's lines, and rewrites its hook file only when it changed", () => {
    const { projectDir, run } = copilotProject()
    const exclude = path.join(projectDir, ".git", "info", "exclude")
    const personHook = path.join(projectDir, ".github", "hooks", "person.json")
    writeFileSync(exclude, "# person's excludes\nbuild/")
    writeFileSync(personHook, '{"person":true}')
    run("tab-1")
    const hookFile = path.join(projectDir, ".github", "hooks", "claxedo-notify.json")
    const first = statSync(hookFile).mtimeMs
    expect(readFileSync(exclude, "utf-8")).toBe("# person's excludes\nbuild/\n.github/hooks/claxedo-notify.json\n")
    run("tab-1")
    expect(readFileSync(exclude, "utf-8")).toBe("# person's excludes\nbuild/\n.github/hooks/claxedo-notify.json\n")
    expect(statSync(hookFile).mtimeMs).toBe(first)
    expect(readFileSync(personHook, "utf-8")).toBe('{"person":true}')
  })

  it("outside a tab writes nothing into the project", () => {
    const { projectDir, run } = copilotProject()
    rmSync(path.join(projectDir, ".github"), { recursive: true, force: true })
    writeFileSync(path.join(projectDir, ".git", "info", "exclude"), "")
    run("")
    expect(existsSync(path.join(projectDir, ".github"))).toBe(false)
    expect(readFileSync(path.join(projectDir, ".git", "info", "exclude"), "utf-8")).toBe("")
  })
})

describe.skipIf(!posixShebang)("codex wrapper integration", () => {
  function run(args: string[], env: Record<string, string>) {
    const realBinDir = path.join(TEST_ROOT, "real-bin")
    const wrapperPath = path.join(TEST_ROOT, "bin", "codex")
    const argsFile = path.join(TEST_ROOT, "codex-args.txt")
    const notifyPath = path.join(TEST_ROOT, "hooks", "notify.sh")
    mkdirSync(realBinDir, { recursive: true })
    mkdirSync(path.dirname(wrapperPath), { recursive: true })
    writeFileSync(path.join(realBinDir, "codex"), `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 0\n`, { mode: 0o755 })
    chmodSync(path.join(realBinDir, "codex"), 0o755)
    writeFileSync(wrapperPath, wrapper("codex", notifyPath), { mode: 0o755 })
    chmodSync(wrapperPath, 0o755)
    execFileSync(wrapperPath, args, { env: { ...process.env, CLAXEDO_TAB_ID: "", ...env, PATH: `${realBinDir}:${process.env.PATH || ""}` }, encoding: "utf-8" })
    return { args: readFileSync(argsFile, "utf-8").trimEnd().split("\n"), flags: argumentsFor("codex", notifyPath) }
  }

  it("inside a tab, turns hooks on, bypasses hook trust once and adds the hook flags ahead of the caller's arguments", () => {
    const { args, flags } = run(["exec", "Reply with exactly OK."], { CLAXEDO_TAB_ID: "tab-1" })
    expect(args).toEqual(["--enable", "hooks", "--dangerously-bypass-hook-trust", ...flags, "exec", "Reply with exactly OK."])
  })

  it("does not repeat a trust bypass the caller already passed", () => {
    const { args, flags } = run(["--dangerously-bypass-hook-trust", "resume"], { CLAXEDO_TAB_ID: "tab-1" })
    expect(args).toEqual(["--enable", "hooks", ...flags, "--dangerously-bypass-hook-trust", "resume"])
  })

  it("outside a tab, passes the caller's arguments through untouched", () => {
    expect(run(["exec", "hello"], {}).args).toEqual(["exec", "hello"])
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
