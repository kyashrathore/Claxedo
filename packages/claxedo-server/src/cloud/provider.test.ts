import { afterAll, describe, expect, test, vi } from "vitest"

vi.mock("../credentials/registry", () => ({
  getCredentialByProvider: vi.fn(() => undefined),
  resolveSecret: vi.fn(() => Promise.resolve(undefined)),
}))

import { sandboxProvider, defaultSandboxProvider, sandboxAuth, listSandboxProviders } from "./sandbox"
import type { SandboxConfig } from "./types"

// Save and clear env vars that could interfere
const envKeys = [
  "DAYTONA_API_KEY",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_SANDBOX_WORKER_URL",
] as const
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
    expect(sandboxProvider("vercel")).toBe("vercel")
    expect(sandboxProvider("cloudflare")).toBe("cloudflare")
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
    expect(defaultSandboxProvider({ default_provider: "vercel" })).toBe("vercel")
    expect(defaultSandboxProvider({ default_provider: "cloudflare" })).toBe("cloudflare")
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

  // ── Vercel auth ──────────────────────────────────────────────────────

  test("returns vercel auth from config", () => {
    const cfg: SandboxConfig = {
      auth: { vercel: { access_token: "vt_abc123", team_id: "team_123", project_id: "prj_123" } },
    }
    const auth = sandboxAuth(cfg, "vercel")
    expect(auth).toEqual({ access_token: "vt_abc123", team_id: "team_123", project_id: "prj_123" })
  })

  test("returns undefined for vercel when no token configured or in env", () => {
    const auth = sandboxAuth({}, "vercel")
    expect(auth).toBeUndefined()
  })

  test("falls back to VERCEL_TOKEN env var", () => {
    process.env.VERCEL_TOKEN = "vt_from_env"
    process.env.VERCEL_TEAM_ID = "team_env"
    process.env.VERCEL_PROJECT_ID = "prj_env"
    try {
      const auth = sandboxAuth({}, "vercel")
      expect(auth).toEqual({ access_token: "vt_from_env", team_id: "team_env", project_id: "prj_env" })
    } finally {
      delete process.env.VERCEL_TOKEN
      delete process.env.VERCEL_TEAM_ID
      delete process.env.VERCEL_PROJECT_ID
    }
  })

  // ── Cloudflare auth ──────────────────────────────────────────────────

  test("returns cloudflare auth from config", () => {
    const cfg: SandboxConfig = {
      auth: {
        cloudflare: {
          api_token: "cf_tok_123",
          worker_url: "https://sandbox.example.workers.dev",
        },
      },
    }
    const auth = sandboxAuth(cfg, "cloudflare")
    expect(auth).toEqual({
      api_token: "cf_tok_123",
      worker_url: "https://sandbox.example.workers.dev",
    })
  })

  test("returns undefined for cloudflare when only api_token is present (needs both)", () => {
    const cfg: SandboxConfig = {
      auth: { cloudflare: { api_token: "cf_tok_only" } },
    }
    const auth = sandboxAuth(cfg, "cloudflare")
    expect(auth).toBeUndefined()
  })

  test("falls back to CLOUDFLARE_API_TOKEN + CLOUDFLARE_SANDBOX_WORKER_URL env vars", () => {
    process.env.CLOUDFLARE_API_TOKEN = "cf_env"
    process.env.CLOUDFLARE_SANDBOX_WORKER_URL = "https://cf.workers.dev"
    try {
      const auth = sandboxAuth({}, "cloudflare")
      expect(auth).toEqual({
        api_token: "cf_env",
        worker_url: "https://cf.workers.dev",
      })
    } finally {
      delete process.env.CLOUDFLARE_API_TOKEN
      delete process.env.CLOUDFLARE_SANDBOX_WORKER_URL
    }
  })

  // ── General auth behavior ─────────────────────────────────────────

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
    expect(result.providers).toHaveLength(4)

    const daytona = result.providers.find((p) => p.id === "daytona")!
    // daytona may show as configured if a managed credential exists in the DB
    expect(daytona.default).toBe(false)
    expect(daytona.fields.length).toBeGreaterThan(0)

    const modal = result.providers.find((p) => p.id === "modal")!
    expect(modal.configured).toBe(true)
    expect(modal.default).toBe(true)

    const vercel = result.providers.find((p) => p.id === "vercel")!
    expect(vercel.configured).toBe(false)
    expect(vercel.default).toBe(false)
    expect(vercel.fields).toEqual([
      { key: "access_token", label: "Access Token", secret: true },
      { key: "team_id", label: "Team ID" },
      { key: "project_id", label: "Project ID" },
    ])

    const cloudflare = result.providers.find((p) => p.id === "cloudflare")!
    expect(cloudflare.configured).toBe(false)
    expect(cloudflare.default).toBe(false)
    expect(cloudflare.fields).toHaveLength(2)
  })

  test("lists providers with no config", () => {
    const result = listSandboxProviders()
    expect(result.default_provider).toBe("daytona")
    const daytona = result.providers.find((p) => p.id === "daytona")!
    expect(daytona.default).toBe(true)
  })

  test("vercel shows configured when token is set", () => {
    const cfg: SandboxConfig = {
      default_provider: "vercel",
      auth: { vercel: { access_token: "vt_test" } },
    }
    const result = listSandboxProviders(cfg)
    const vercel = result.providers.find((p) => p.id === "vercel")!
    expect(vercel.configured).toBe(true)
    expect(vercel.default).toBe(true)
  })

  test("cloudflare shows configured when both fields are set", () => {
    const cfg: SandboxConfig = {
      auth: {
        cloudflare: {
          api_token: "cf_tok",
          worker_url: "https://cf.workers.dev",
        },
      },
    }
    const result = listSandboxProviders(cfg)
    const cf = result.providers.find((p) => p.id === "cloudflare")!
    expect(cf.configured).toBe(true)
  })
})
