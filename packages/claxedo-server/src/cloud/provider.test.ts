import { describe, expect, test, afterAll } from "vitest"
import { sandboxProvider, defaultSandboxProvider, sandboxAuth, listSandboxProviders } from "./provider"
import type { SandboxConfig } from "./types"

// Save and clear env vars that could interfere
const envKeys = ["DAYTONA_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"] as const
const savedEnv: Partial<Record<string, string>> = {}
for (const k of envKeys) {
  savedEnv[k] = process.env[k]
  delete process.env[k]
}

afterAll(() => {
  for (const k of envKeys) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    else delete process.env[k]
  }
})

describe("sandbox provider", () => {
  // ── sandboxProvider ──────────────────────────────────────────────────

  test("accepts valid provider ids", () => {
    expect(sandboxProvider("daytona")).toBe("daytona")
    expect(sandboxProvider("modal")).toBe("modal")
  })

  test("rejects unknown provider ids", () => {
    expect(sandboxProvider("aws")).toBeUndefined()
    expect(sandboxProvider("")).toBeUndefined()
    expect(sandboxProvider(undefined)).toBeUndefined()
  })

  // ── defaultSandboxProvider ───────────────────────────────────────────

  test("defaults to daytona when no config", () => {
    expect(defaultSandboxProvider()).toBe("daytona")
    expect(defaultSandboxProvider({})).toBe("daytona")
  })

  test("respects configured default_provider", () => {
    expect(defaultSandboxProvider({ default_provider: "modal" })).toBe("modal")
  })

  test("falls back to daytona for invalid default_provider", () => {
    expect(defaultSandboxProvider({ default_provider: "invalid" as any })).toBe("daytona")
  })

  // ── sandboxAuth ────────────────────────────────────────────────────

  test("returns daytona auth from config", () => {
    const cfg: SandboxConfig = {
      auth: { daytona: { api_key: "dtk_123" } },
    }
    const auth = sandboxAuth(cfg, "daytona")
    expect(auth).toEqual({ api_key: "dtk_123" })
  })

  test("returns undefined for daytona when no key configured or in env", () => {
    const auth = sandboxAuth({}, "daytona")
    expect(auth).toBeUndefined()
  })

  test("falls back to DAYTONA_API_KEY env var", () => {
    process.env.DAYTONA_API_KEY = "dtk_from_env"
    try {
      const auth = sandboxAuth({}, "daytona")
      expect(auth).toEqual({ api_key: "dtk_from_env" })
    } finally {
      delete process.env.DAYTONA_API_KEY
    }
  })

  test("returns modal auth from config", () => {
    const cfg: SandboxConfig = {
      auth: { modal: { token_id: "mid_123", token_secret: "msec_123" } },
    }
    const auth = sandboxAuth(cfg, "modal")
    expect(auth).toEqual({ token_id: "mid_123", token_secret: "msec_123" })
  })

  test("returns undefined for modal when only token_id is present (needs both)", () => {
    const cfg: SandboxConfig = {
      auth: { modal: { token_id: "mid_only" } },
    }
    const auth = sandboxAuth(cfg, "modal")
    expect(auth).toBeUndefined()
  })

  test("falls back to MODAL_TOKEN_ID + MODAL_TOKEN_SECRET env vars", () => {
    process.env.MODAL_TOKEN_ID = "mid_env"
    process.env.MODAL_TOKEN_SECRET = "msec_env"
    try {
      const auth = sandboxAuth({}, "modal")
      expect(auth).toEqual({ token_id: "mid_env", token_secret: "msec_env" })
    } finally {
      delete process.env.MODAL_TOKEN_ID
      delete process.env.MODAL_TOKEN_SECRET
    }
  })

  test("trims whitespace from auth values", () => {
    const cfg: SandboxConfig = {
      auth: { daytona: { api_key: "  dtk_trimmed  " } },
    }
    const auth = sandboxAuth(cfg, "daytona")
    expect(auth).toEqual({ api_key: "dtk_trimmed" })
  })

  test("treats empty/whitespace-only strings as missing", () => {
    const cfg: SandboxConfig = {
      auth: { daytona: { api_key: "   " } },
    }
    const auth = sandboxAuth(cfg, "daytona")
    expect(auth).toBeUndefined()
  })

  // ── listSandboxProviders ─────────────────────────────────────────────

  test("lists all providers with configuration status", () => {
    const cfg: SandboxConfig = {
      default_provider: "modal",
      auth: {
        modal: { token_id: "id", token_secret: "sec" },
      },
    }
    const result = listSandboxProviders(cfg)

    expect(result.default_provider).toBe("modal")
    expect(result.providers).toHaveLength(2)

    const daytona = result.providers.find((p) => p.id === "daytona")!
    expect(daytona.configured).toBe(false)
    expect(daytona.default).toBe(false)
    expect(daytona.fields.length).toBeGreaterThan(0)

    const modal = result.providers.find((p) => p.id === "modal")!
    expect(modal.configured).toBe(true)
    expect(modal.default).toBe(true)
  })

  test("lists providers with no config", () => {
    const result = listSandboxProviders()
    expect(result.default_provider).toBe("daytona")
    const daytona = result.providers.find((p) => p.id === "daytona")!
    expect(daytona.default).toBe(true)
  })
})
