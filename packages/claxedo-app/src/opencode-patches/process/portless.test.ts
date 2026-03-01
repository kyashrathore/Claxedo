import { describe, test, expect } from "bun:test"
import { buildPortlessCommand, configChanged, sanitizeShellArg } from "./portless"
import type { Process } from "./process"

const BIN = "/usr/local/lib/node_modules/.bin/portless"
/** buildPortlessCommand single-quotes the binary path for shell safety */
const Q = (b: string) => `'${b}'`

// ── buildPortlessCommand ─────────────────────────────────────────────────────

describe("buildPortlessCommand", () => {
  describe("env mode with PORT (native)", () => {
    test("wraps command directly — no sh -c wrapper needed", () => {
      const result = buildPortlessCommand("npm run dev", BIN, "my-app", "env", "PORT")
      expect(result).toBe(`${Q(BIN)} my-app npm run dev`)
    })

    test("preserves multi-word commands", () => {
      const result = buildPortlessCommand("bun run dev serve", BIN, "api", "env", "PORT")
      expect(result).toBe(`${Q(BIN)} api bun run dev serve`)
    })
  })

  describe("env mode with custom variable", () => {
    test("wraps with sh -c and exports custom var from $PORT", () => {
      const result = buildPortlessCommand("npm run dev", BIN, "my-app", "env", "VITE_PORT")
      expect(result).toBe(`${Q(BIN)} my-app sh -c 'export VITE_PORT=$PORT; exec npm run dev'`)
    })

    test("handles different custom env var names", () => {
      const result = buildPortlessCommand("python app.py", BIN, "py-api", "env", "APP_PORT")
      expect(result).toBe(`${Q(BIN)} py-api sh -c 'export APP_PORT=$PORT; exec python app.py'`)
    })

    test("escapes single quotes in command", () => {
      const result = buildPortlessCommand("echo 'hello world'", BIN, "app", "env", "CUSTOM")
      expect(result).toBe(`${Q(BIN)} app sh -c 'export CUSTOM=$PORT; exec echo '\\''hello world'\\'''`)
    })
  })

  describe("flag mode", () => {
    test("appends --port flag and $PORT to command", () => {
      const result = buildPortlessCommand("bun run dev serve", BIN, "api", "flag", "--port")
      expect(result).toBe(`${Q(BIN)} api sh -c 'exec bun run dev serve --port $PORT'`)
    })

    test("works with short flags like -p", () => {
      const result = buildPortlessCommand("node server.js", BIN, "srv", "flag", "-p")
      expect(result).toBe(`${Q(BIN)} srv sh -c 'exec node server.js -p $PORT'`)
    })

    test("works with --listen flag", () => {
      const result = buildPortlessCommand("deno run app.ts", BIN, "deno", "flag", "--port")
      expect(result).toBe(`${Q(BIN)} deno sh -c 'exec deno run app.ts --port $PORT'`)
    })

    test("escapes single quotes in command", () => {
      const result = buildPortlessCommand("echo 'test'", BIN, "app", "flag", "--port")
      expect(result).toBe(`${Q(BIN)} app sh -c 'exec echo '\\''test'\\'' --port $PORT'`)
    })
  })

  describe("absolute portless binary path", () => {
    test("deep nested path is preserved in native mode", () => {
      const deep = "/Users/dev/project/packages/claxedo-app/node_modules/.bin/portless"
      const result = buildPortlessCommand("npm start", deep, "app", "env", "PORT")
      expect(result).toBe(`${Q(deep)} app npm start`)
    })

    test("deep nested path is preserved in flag mode", () => {
      const deep = "/some/deep/path/portless"
      const result = buildPortlessCommand("npm start", deep, "app", "flag", "--port")
      expect(result).toBe(`${Q(deep)} app sh -c 'exec npm start --port $PORT'`)
    })
  })
})

// ── sanitizeShellArg ─────────────────────────────────────────────────────────

describe("sanitizeShellArg", () => {
  test("allows alphanumeric, dots, hyphens, underscores, slashes", () => {
    expect(sanitizeShellArg("my-app.local")).toBe("my-app.local")
    expect(sanitizeShellArg("PORT")).toBe("PORT")
    expect(sanitizeShellArg("--port")).toBe("--port")
    expect(sanitizeShellArg("VITE_PORT")).toBe("VITE_PORT")
    expect(sanitizeShellArg("/usr/bin/thing")).toBe("/usr/bin/thing")
  })

  test("strips shell metacharacters", () => {
    expect(sanitizeShellArg("foo; rm -rf /")).toBe("foorm-rf/")
    expect(sanitizeShellArg("$(whoami)")).toBe("whoami")
    expect(sanitizeShellArg("`id`")).toBe("id")
    expect(sanitizeShellArg("a | b")).toBe("ab")
    expect(sanitizeShellArg("a && b")).toBe("ab")
    expect(sanitizeShellArg("a'b\"c")).toBe("abc")
  })

  test("returns empty string for all-special input", () => {
    expect(sanitizeShellArg("$()`';|&")).toBe("")
  })
})

// ── configChanged ────────────────────────────────────────────────────────────

describe("configChanged", () => {
  const makeConfig = (overrides: Partial<Process.ProcessConfig> = {}): Process.ProcessConfig => ({
    id: "proc_test",
    name: "test",
    command: "echo hi",
    args: [],
    autoStart: false,
    restartPolicy: "never",
    maxRestarts: 3,
    ...overrides,
  })

  test("identical configs are not changed", () => {
    const a = makeConfig()
    const b = makeConfig()
    expect(configChanged(a, b)).toBe(false)
  })

  describe("portless fields trigger change", () => {
    test("portless added detected", () => {
      expect(configChanged(
        makeConfig(),
        makeConfig({ portless: { hostname: "app", portMode: "env", portValue: "PORT" } }),
      )).toBe(true)
    })

    test("portless removed detected", () => {
      expect(configChanged(
        makeConfig({ portless: { hostname: "app", portMode: "env", portValue: "PORT" } }),
        makeConfig(),
      )).toBe(true)
    })

    test("hostname change detected", () => {
      expect(configChanged(
        makeConfig({ portless: { hostname: "app-a", portMode: "env", portValue: "PORT" } }),
        makeConfig({ portless: { hostname: "app-b", portMode: "env", portValue: "PORT" } }),
      )).toBe(true)
    })

    test("portMode change detected (env → flag)", () => {
      expect(configChanged(
        makeConfig({ portless: { hostname: "app", portMode: "env", portValue: "PORT" } }),
        makeConfig({ portless: { hostname: "app", portMode: "flag", portValue: "PORT" } }),
      )).toBe(true)
    })

    test("portValue change detected (PORT → --port)", () => {
      expect(configChanged(
        makeConfig({ portless: { hostname: "app", portMode: "env", portValue: "PORT" } }),
        makeConfig({ portless: { hostname: "app", portMode: "env", portValue: "--port" } }),
      )).toBe(true)
    })

    test("portValue change detected (PORT → CUSTOM_PORT)", () => {
      expect(configChanged(
        makeConfig({ portless: { hostname: "app", portMode: "env", portValue: "PORT" } }),
        makeConfig({ portless: { hostname: "app", portMode: "env", portValue: "CUSTOM_PORT" } }),
      )).toBe(true)
    })

    test("identical portless configs are not changed", () => {
      expect(configChanged(
        makeConfig({ portless: { hostname: "app", portMode: "env", portValue: "PORT" } }),
        makeConfig({ portless: { hostname: "app", portMode: "env", portValue: "PORT" } }),
      )).toBe(false)
    })
  })

  describe("other execution fields trigger change", () => {
    test("command", () => {
      expect(configChanged(makeConfig({ command: "a" }), makeConfig({ command: "b" }))).toBe(true)
    })

    test("args", () => {
      expect(configChanged(makeConfig({ args: ["a"] }), makeConfig({ args: ["b"] }))).toBe(true)
    })

    test("cwd", () => {
      expect(configChanged(makeConfig({ cwd: "a" }), makeConfig({ cwd: "b" }))).toBe(true)
    })

    test("env", () => {
      expect(configChanged(
        makeConfig({ env: { A: "1" } }),
        makeConfig({ env: { A: "2" } }),
      )).toBe(true)
    })

    test("restartPolicy", () => {
      expect(configChanged(
        makeConfig({ restartPolicy: "never" }),
        makeConfig({ restartPolicy: "always" }),
      )).toBe(true)
    })

    test("maxRestarts", () => {
      expect(configChanged(makeConfig({ maxRestarts: 3 }), makeConfig({ maxRestarts: 5 }))).toBe(true)
    })
  })

  describe("non-execution fields do NOT trigger change", () => {
    test("name change ignored", () => {
      expect(configChanged(makeConfig({ name: "old" }), makeConfig({ name: "new" }))).toBe(false)
    })

    test("color change ignored", () => {
      expect(configChanged(
        makeConfig({ color: "#ff0000" }),
        makeConfig({ color: "#00ff00" }),
      )).toBe(false)
    })

    test("autoStart change ignored", () => {
      expect(configChanged(
        makeConfig({ autoStart: false }),
        makeConfig({ autoStart: true }),
      )).toBe(false)
    })
  })
})
