import { describe, expect, test } from "bun:test"
import { buildSafeEnv, getLocale } from "./env"

describe("buildSafeEnv", () => {
  test("passes through allowed vars", () => {
    const result = buildSafeEnv({ PATH: "/usr/bin", HOME: "/home/user", SHELL: "/bin/bash" })
    expect(result.PATH).toBe("/usr/bin")
    expect(result.HOME).toBe("/home/user")
    expect(result.SHELL).toBe("/bin/bash")
  })

  test("blocks deny-listed vars", () => {
    const result = buildSafeEnv({
      PATH: "/usr/bin",
      NODE_OPTIONS: "--max-old-space-size=4096",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_PATH: "/custom/path",
    })
    expect(result.PATH).toBe("/usr/bin")
    expect(result.NODE_OPTIONS).toBeUndefined()
    expect(result.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(result.NODE_PATH).toBeUndefined()
  })

  test("passes through OPENCODE_ prefixed vars", () => {
    const result = buildSafeEnv({
      OPENCODE_CUSTOM_FLAG: "1",
      OPENCODE_TERMINAL: "1",
    })
    expect(result.OPENCODE_CUSTOM_FLAG).toBe("1")
    expect(result.OPENCODE_TERMINAL).toBe("1")
  })

  test("passes through CLAXEDO_ prefixed vars", () => {
    const result = buildSafeEnv({
      CLAXEDO_PORT: "7860",
      CLAXEDO_WORKSPACE_ID: "ws_123",
    })
    expect(result.CLAXEDO_PORT).toBe("7860")
    expect(result.CLAXEDO_WORKSPACE_ID).toBe("ws_123")
  })

  test("never exposes the local document installation credential", () => {
    expect(buildSafeEnv({
      CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN: "secret",
      claxedo_local_document_broker_token: "secret-lower",
      CLAXEDO_WORKSPACE_ID: "ws_1",
    })).toEqual({ CLAXEDO_WORKSPACE_ID: "ws_1" })
  })

  test("passes through common process port vars", () => {
    const result = buildSafeEnv({ PORT: "3000" })
    expect(result.PORT).toBe("3000")
  })

  test("passes through custom prefix vars", () => {
    const result = buildSafeEnv({ MYAPP_SECRET: "abc" }, { customPrefix: "MYAPP" })
    expect(result.MYAPP_SECRET).toBe("abc")
  })

  test("drops unknown vars without matching prefix", () => {
    const result = buildSafeEnv({ RANDOM_VAR: "nope", OBSCURE_SETTING: "hidden" })
    expect(result.RANDOM_VAR).toBeUndefined()
    expect(result.OBSCURE_SETTING).toBeUndefined()
  })

  test("skips undefined values", () => {
    const result = buildSafeEnv({ PATH: undefined as unknown as string, HOME: "/home/user" })
    expect("PATH" in result).toBe(false)
    expect(result.HOME).toBe("/home/user")
  })

  // -- Windows-specific behavior --

  test("Windows: allows case-insensitive matching of allowed vars", () => {
    const result = buildSafeEnv({ path: "/usr/bin", Path: "/usr/bin2", HOME: "/home" }, { platform: "win32" })
    // Both 'path' and 'Path' should be allowed (case-insensitive match for PATH)
    expect(result.path ?? result.Path).toBeDefined()
    expect(result.HOME).toBe("/home")
  })

  test("Windows: case-insensitive deny list blocks NODE_OPTIONS variants", () => {
    const result = buildSafeEnv({ node_options: "--inspect", Node_Options: "--experimental" }, { platform: "win32" })
    expect(result.node_options).toBeUndefined()
    expect(result.Node_Options).toBeUndefined()
  })

  test("Windows: case-insensitive prefix matching for OPENCODE_ vars", () => {
    const result = buildSafeEnv({ opencode_debug: "1", Opencode_Terminal: "1" }, { platform: "win32" })
    expect(result.opencode_debug).toBe("1")
    expect(result.Opencode_Terminal).toBe("1")
  })

  test("Windows: allows Windows-specific env vars", () => {
    const result = buildSafeEnv(
      {
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        USERPROFILE: "C:\\Users\\test",
        APPDATA: "C:\\Users\\test\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
        SYSTEMROOT: "C:\\Windows",
        WINDIR: "C:\\Windows",
        TEMP: "C:\\Users\\test\\AppData\\Local\\Temp",
        TMP: "C:\\Users\\test\\AppData\\Local\\Temp",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        OS: "Windows_NT",
        PROCESSOR_ARCHITECTURE: "AMD64",
      },
      { platform: "win32" },
    )
    expect(result.COMSPEC).toBe("C:\\Windows\\System32\\cmd.exe")
    expect(result.USERPROFILE).toBe("C:\\Users\\test")
    expect(result.APPDATA).toBeDefined()
    expect(result.LOCALAPPDATA).toBeDefined()
    expect(result.SYSTEMROOT).toBeDefined()
    expect(result.WINDIR).toBeDefined()
    expect(result.TEMP).toBeDefined()
    expect(result.TMP).toBeDefined()
    expect(result.PATHEXT).toBeDefined()
    expect(result.OS).toBeDefined()
    expect(result.PROCESSOR_ARCHITECTURE).toBeDefined()
  })

  test("drops the host terminal's identity markers", () => {
    // We announce our own identity (pty/identity.ts). Leaking the host
    // emulator's markers makes a TUI detect kitty/iTerm/Windows Terminal and
    // enable behaviour our xterm does not implement — and makes it vary by
    // whichever terminal happened to launch the desktop app.
    const result = buildSafeEnv(
      {
        WT_SESSION: "{guid}",
        WT_PROFILE_ID: "{profile-guid}",
        KITTY_PID: "1234",
        ITERM_SESSION_ID: "w0t0p0",
        ITERM_PROFILE: "Default",
        TERM_SESSION_ID: "abc",
        WEZTERM_EXECUTABLE: "/usr/bin/wezterm",
        WEZTERM_CONFIG_DIR: "/home/me/.wezterm",
        ALACRITTY_SOCKET: "/tmp/alacritty.sock",
        GHOSTTY_RESOURCES_DIR: "/opt/ghostty",
        TERM_PROGRAM: "Apple_Terminal",
        TERM_PROGRAM_VERSION: "455",
      },
      { platform: "win32" },
    )
    for (const key of [
      "WT_SESSION",
      "WT_PROFILE_ID",
      "KITTY_PID",
      "ITERM_SESSION_ID",
      "ITERM_PROFILE",
      "TERM_SESSION_ID",
      "WEZTERM_EXECUTABLE",
      "WEZTERM_CONFIG_DIR",
      "ALACRITTY_SOCKET",
      "GHOSTTY_RESOURCES_DIR",
      "TERM_PROGRAM",
      "TERM_PROGRAM_VERSION",
    ]) {
      expect(result[key]).toBeUndefined()
    }
  })

  test("keeps COLORTERM, which describes capability rather than identity", () => {
    const result = buildSafeEnv({ COLORTERM: "truecolor" }, { platform: "darwin" })
    expect(result.COLORTERM).toBe("truecolor")
  })

  test("non-Windows: does not use case-insensitive matching", () => {
    const result = buildSafeEnv({ path: "/usr/bin" }, { platform: "linux" })
    // 'path' (lowercase) is not in the allowed set; only 'PATH' is
    expect(result.path).toBeUndefined()
  })
})

describe("getLocale", () => {
  test("returns UTF-8 locale from LC_ALL", () => {
    expect(getLocale({ LC_ALL: "en_US.UTF-8" })).toBe("en_US.UTF-8")
  })

  test("returns UTF-8 locale from LANG when LC_ALL missing", () => {
    expect(getLocale({ LANG: "C.utf8" })).toBe("C.utf8")
  })

  test("falls back to en_US.UTF-8 when no UTF-8 locale set", () => {
    expect(getLocale({})).toBe("en_US.UTF-8")
    expect(getLocale({ LANG: "C" })).toBe("en_US.UTF-8")
  })
})
