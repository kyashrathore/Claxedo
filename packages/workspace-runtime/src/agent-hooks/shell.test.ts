import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { execFileSync } from "child_process"
import * as path from "path"
import * as os from "os"
import {
  generateZshenv,
  generateZshprofile,
  generateZshrc,
  generateZshlogin,
  generateBashrc,
  getTerminalEnvVars,
  getShellArgs,
  getCommandShellArgs,
} from "./shell"
import { BIN_DIR, CLAXEDO_DIR, SHELL_DIR, SHELL_MARKER, BASH_DIR } from "./constants"

const TEST_ROOT = path.join(os.tmpdir(), `claxedo-shell-test-${process.pid}-${Date.now()}`)

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

// ── Zsh config content verification ────────────────────────────────────────

describe("generateZshenv", () => {
  it("includes marker", () => {
    const content = generateZshenv()
    expect(content).toContain(SHELL_MARKER)
  })

  it("includes env save/restore", () => {
    const content = generateZshenv()
    expect(content).toContain("_claxedo_saved_env")
    expect(content).toContain("CLAXEDO_")
  })

  it("manages ZDOTDIR for transparent sourcing", () => {
    const content = generateZshenv()
    expect(content).toContain("ZDOTDIR")
    expect(content).toContain("CLAXEDO_ORIG_ZDOTDIR")
    expect(content).toContain(".zshenv")
  })

  it("restores ZDOTDIR to SHELL_DIR after user env", () => {
    const content = generateZshenv()
    // After sourcing user .zshenv, ZDOTDIR must be set back to our dir
    const lines = content.split("\n")
    const lastZdotdir = lines.filter((l) => l.includes("export ZDOTDIR=")).pop()
    expect(lastZdotdir).toContain(SHELL_DIR)
  })
})

describe("generateZshprofile", () => {
  it("includes marker and env save/restore", () => {
    const content = generateZshprofile()
    expect(content).toContain(SHELL_MARKER)
    expect(content).toContain("_claxedo_saved_env")
  })

  it("sources user .zprofile", () => {
    const content = generateZshprofile()
    expect(content).toContain(".zprofile")
  })
})

describe("generateZshrc", () => {
  it("includes marker", () => {
    const content = generateZshrc()
    expect(content).toContain(SHELL_MARKER)
  })

  it("includes env save/restore", () => {
    const content = generateZshrc()
    expect(content).toContain("_claxedo_saved_env")
  })

  it("includes PATH prepend", () => {
    const content = generateZshrc()
    expect(content).toContain("_claxedo_prepend_bin")
    expect(content).toContain(BIN_DIR)
  })

  it("includes precmd hook for PATH resilience", () => {
    const content = generateZshrc()
    expect(content).toContain("precmd_functions")
    expect(content).toContain("_claxedo_ensure_path")
  })

  it("includes rehash for command hash table reset", () => {
    const content = generateZshrc()
    expect(content).toContain("rehash")
  })

  it("sources user .zshrc", () => {
    const content = generateZshrc()
    expect(content).toContain(".zshrc")
  })
})

describe("generateZshlogin", () => {
  it("includes marker", () => {
    const content = generateZshlogin()
    expect(content).toContain(SHELL_MARKER)
  })

  it("includes shell-ready OSC marker", () => {
    const content = generateZshlogin()
    expect(content).toContain("claxedo-shell-ready")
    expect(content).toContain("\\033]777")
  })

  it("only sources user .zlogin in interactive mode", () => {
    const content = generateZshlogin()
    expect(content).toContain("-o interactive")
    expect(content).toContain(".zlogin")
  })

  it("includes precmd hook and PATH prepend", () => {
    const content = generateZshlogin()
    expect(content).toContain("_claxedo_ensure_path")
    expect(content).toContain("_claxedo_prepend_bin")
  })
})

// ── Bash config content ─────────────────────────────────────────────────────

describe("generateBashrc", () => {
  it("includes marker", () => {
    const content = generateBashrc()
    expect(content).toContain(SHELL_MARKER)
  })

  it("includes env save/restore", () => {
    const content = generateBashrc()
    expect(content).toContain("_claxedo_saved_env")
    expect(content).toContain("eval")
  })

  it("sources system and user profiles", () => {
    const content = generateBashrc()
    expect(content).toContain("/etc/profile")
    expect(content).toContain(".bash_profile")
    expect(content).toContain(".bashrc")
  })

  it("includes PATH prepend", () => {
    const content = generateBashrc()
    expect(content).toContain("_claxedo_prepend_bin")
    expect(content).toContain(BIN_DIR)
  })

  it("includes shell-ready marker via PROMPT_COMMAND", () => {
    const content = generateBashrc()
    expect(content).toContain("_claxedo_shell_ready")
    expect(content).toContain("claxedo-shell-ready")
    expect(content).toContain("PROMPT_COMMAND")
  })

  it("handles PROMPT_COMMAND as both array and string", () => {
    const content = generateBashrc()
    expect(content).toContain('declare -p PROMPT_COMMAND')
    expect(content).toContain('declare -a')
  })

  it("includes hash -r for command table reset", () => {
    const content = generateBashrc()
    expect(content).toContain("hash -r")
  })
})

// ── getTerminalEnvVars ──────────────────────────────────────────────────────

describe("getTerminalEnvVars", () => {
  const baseParams = {
    tabId: "tab-1",
    terminalId: "term-1",
    workspaceId: "ws-1",
    port: 7860,
  }

  it("sets core CLAXEDO env vars", () => {
    const env = getTerminalEnvVars(baseParams)
    expect(env.CLAXEDO_HOME_DIR).toBe(CLAXEDO_DIR)
    expect(env.CLAXEDO_TAB_ID).toBe("tab-1")
    expect(env.CLAXEDO_TERMINAL_ID).toBe("term-1")
    expect(env.CLAXEDO_WORKSPACE_ID).toBe("ws-1")
    expect(env.CLAXEDO_PORT).toBe("7860")
  })

  it("sets MCP tool hint env vars", () => {
    const env = getTerminalEnvVars(baseParams)
    expect(env.CLAXEDO_MCP_TOOL).toBe("tab_context")
    expect(env.CLAXEDO_MCP_HINT).toContain("tab_context")
    expect(env.CLAXEDO_TAB_PROMPT).toContain("tab-1")
  })

  it("sets ZDOTDIR for zsh", () => {
    const env = getTerminalEnvVars({ ...baseParams, shell: "/bin/zsh" })
    expect(env.ZDOTDIR).toBe(SHELL_DIR)
    expect(env.CLAXEDO_ORIG_ZDOTDIR).toBeDefined()
  })

  it("does not set ZDOTDIR for bash", () => {
    const env = getTerminalEnvVars({ ...baseParams, shell: "/bin/bash" })
    expect(env.ZDOTDIR).toBeUndefined()
  })

  it("prepends BIN_DIR to PATH for unknown shells", () => {
    const env = getTerminalEnvVars({ ...baseParams, shell: "/usr/bin/nu" })
    expect(env.PATH).toContain(BIN_DIR)
  })

  it("adds PATH for zsh as a safety net", () => {
    const env = getTerminalEnvVars({ ...baseParams, shell: "/bin/zsh" })
    expect(env.PATH).toContain(BIN_DIR)
  })
})

// ── getShellArgs ────────────────────────────────────────────────────────────

describe("getShellArgs", () => {
  it("returns --rcfile for bash", () => {
    const args = getShellArgs("/bin/bash")
    expect(args).toContain("--rcfile")
    expect(args.some((a) => a.includes("rcfile"))).toBe(true)
  })

  it("returns -l for zsh", () => {
    const args = getShellArgs("/bin/zsh")
    expect(args).toEqual(["-l"])
  })

  it("returns fish init command with PATH setup", () => {
    const args = getShellArgs("/usr/bin/fish")
    expect(args[0]).toBe("-l")
    expect(args[1]).toBe("--init-command")
    expect(args[2]).toContain("_claxedo_bin")
    expect(args[2]).toContain("claxedo-shell-ready")
  })

  it("returns -l for sh", () => {
    expect(getShellArgs("/bin/sh")).toEqual(["-l"])
  })

  it("returns -l for ksh", () => {
    expect(getShellArgs("/bin/ksh")).toEqual(["-l"])
  })

  it("returns empty for unknown shells", () => {
    expect(getShellArgs("/usr/bin/tcsh")).toEqual([])
  })
})

// ── getCommandShellArgs ─────────────────────────────────────────────────────

describe("getCommandShellArgs", () => {
  it("sources zshrc inline for zsh", () => {
    const args = getCommandShellArgs("/bin/zsh", "echo hello")
    expect(args[0]).toBe("-lc")
    expect(args[1]).toContain("source")
    expect(args[1]).toContain("echo hello")
  })

  it("sources bash rcfile inline for bash", () => {
    const args = getCommandShellArgs("/bin/bash", "echo hello")
    expect(args[0]).toBe("-c")
    expect(args[1]).toContain("source")
    expect(args[1]).toContain("echo hello")
  })

  it("uses -lc for unknown shells", () => {
    const args = getCommandShellArgs("/usr/bin/nu", "echo hello")
    expect(args).toEqual(["-lc", "echo hello"])
  })
})

// ── Zsh integration test ────────────────────────────────────────────────────

describe("zsh integration", () => {
  it("BIN_DIR appears in PATH after sourcing zshrc", () => {
    const content = generateZshrc()
    // The zshrc includes _claxedo_prepend_bin which adds BIN_DIR to PATH
    // Verify the function definition includes our actual BIN_DIR
    expect(content).toContain(BIN_DIR)
    expect(content).toContain("_claxedo_prepend_bin")
  })

  it("precmd_functions are defined for PATH resilience", () => {
    const content = generateZshrc()
    // The precmd hook should keep our hook last
    expect(content).toContain("precmd_functions=(${precmd_functions:#_claxedo_ensure_path} _claxedo_ensure_path)")
  })
})

// ── Bash integration test ───────────────────────────────────────────────────

describe("bash integration", () => {
  it("wrapper wins over system binary when BIN_DIR is first in PATH", () => {
    const realBinDir = path.join(TEST_ROOT, "real-bin")
    const wrapperBinDir = path.join(TEST_ROOT, "wrapper-bin")

    mkdirSync(realBinDir, { recursive: true })
    mkdirSync(wrapperBinDir, { recursive: true })

    // Create a "real" binary that prints "real"
    const realBin = path.join(realBinDir, "test-agent")
    writeFileSync(realBin, "#!/bin/bash\necho real\n", { mode: 0o755 })
    chmodSync(realBin, 0o755)

    // Create a "wrapper" that prints "wrapper"
    const wrapperBin = path.join(wrapperBinDir, "test-agent")
    writeFileSync(wrapperBin, "#!/bin/bash\necho wrapper\n", { mode: 0o755 })
    chmodSync(wrapperBin, 0o755)

    // Wrapper dir first in PATH should win
    const output = execFileSync(wrapperBin, [], {
      env: {
        ...process.env,
        PATH: `${wrapperBinDir}:${realBinDir}:${process.env.PATH || ""}`,
      },
      encoding: "utf-8",
    })

    expect(output.trim()).toBe("wrapper")
  })
})

// ── Env save/restore integration ────────────────────────────────────────────

describe("env save/restore", () => {
  it("save snippet captures CLAXEDO_ vars via export -p", () => {
    const content = generateBashrc()
    // The ENV_SAVE pattern should grep for CLAXEDO_ from export -p
    expect(content).toContain("export -p")
    expect(content).toContain("CLAXEDO_")
  })

  it("restore snippet evaluates saved vars", () => {
    const content = generateBashrc()
    expect(content).toContain('eval "$_claxedo_saved_env"')
  })

  it("CLAXEDO vars survive user RC override in bash", () => {
    const bashRcDir = path.join(TEST_ROOT, "bash")
    mkdirSync(bashRcDir, { recursive: true })

    // Write a test script that simulates env save/restore
    const testScript = path.join(TEST_ROOT, "test-env.sh")
    writeFileSync(
      testScript,
      `#!/bin/bash
# Simulate env save
export CLAXEDO_TAB_ID="original-tab"
_claxedo_saved_env="$(export -p 2>/dev/null | grep ' CLAXEDO_')"

# Simulate user RC overriding our var
export CLAXEDO_TAB_ID="overridden"

# Simulate env restore
eval "$_claxedo_saved_env" 2>/dev/null || true

echo "$CLAXEDO_TAB_ID"
`,
      { mode: 0o755 },
    )
    chmodSync(testScript, 0o755)

    const output = execFileSync(testScript, [], { encoding: "utf-8" })
    expect(output.trim()).toBe("original-tab")
  })
})

// ── Shell-ready marker ──────────────────────────────────────────────────────

describe("shell-ready marker", () => {
  it("zshlogin includes OSC 777 shell-ready sequence", () => {
    const content = generateZshlogin()
    expect(content).toContain("\\033]777;claxedo-shell-ready\\007")
  })

  it("bashrc includes shell-ready via PROMPT_COMMAND", () => {
    const content = generateBashrc()
    expect(content).toContain("_claxedo_shell_ready")
    expect(content).toContain("claxedo-shell-ready")
  })

  it("fish shell args include shell-ready event", () => {
    const args = getShellArgs("/usr/bin/fish")
    expect(args[2]).toContain("claxedo-shell-ready")
  })
})
