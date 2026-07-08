import { describe, expect, test } from "bun:test"
import {
  CLERK_FRONTEND_API,
  realClerkPreflightMissing,
  realCloudCredentialReason,
  realCloudPreflightMissing,
} from "./real-provider-preflight"

function env(input: Record<string, string | undefined> = {}) {
  return { ...input } as NodeJS.ProcessEnv
}

describe("real provider preflight", () => {
  test("reports missing Clerk and Convex credentials before browser setup", () => {
    expect(realClerkPreflightMissing(env())).toEqual([
      "CLERK_SECRET_KEY",
      "CLERK_PUBLISHABLE_KEY or VITE_CLERK_PUBLISHABLE_KEY",
      "CLERK_JWT_ISSUER",
      "CLERK_JWKS_URL",
      "CLAXEDO_WORKSPACE_AUTHORITY_URL",
    ])
  })

  test("accepts Vite publishable key and applies Clerk frontend default", () => {
    const input = env({
      CLERK_SECRET_KEY: "sk_test",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_test",
      CLERK_JWT_ISSUER: "https://issuer.example.test",
      CLERK_JWKS_URL: "https://issuer.example.test/.well-known/jwks.json",
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.example.test",
    })

    expect(realClerkPreflightMissing(input)).toEqual([])
    expect(input.CLERK_PUBLISHABLE_KEY).toBe("pk_test")
    expect(input.CLERK_FAPI).toBe(CLERK_FRONTEND_API)
  })

  test("reports the selected sandbox provider credential set", () => {
    expect(realCloudCredentialReason("daytona", env())).toBe("DAYTONA_API_KEY")
    expect(realCloudCredentialReason("modal", env({ MODAL_TOKEN_ID: "id" }))).toBe("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET")
    expect(realCloudCredentialReason("vercel", env({ VERCEL_TOKEN: "token", VERCEL_TEAM_ID: "team" }))).toBe("VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID")
    expect(realCloudCredentialReason("cloudflare", env({ CLOUDFLARE_API_TOKEN: "token" }))).toBe("CLOUDFLARE_API_TOKEN and CLOUDFLARE_SANDBOX_WORKER_URL")
    expect(realCloudCredentialReason("unknown", env())).toContain("supported CLAXEDO_E2E_CLOUD_PROVIDER")
  })

  test("accepts managed sandbox credentials without env secrets", () => {
    const base = {
      CLERK_SECRET_KEY: "sk_test",
      CLERK_PUBLISHABLE_KEY: "pk_test",
      CLERK_JWT_ISSUER: "https://issuer.example.test",
      CLERK_JWKS_URL: "https://issuer.example.test/.well-known/jwks.json",
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.example.test",
    }
    const input = env({
      ...base,
      CLAXEDO_E2E_CLOUD_PROVIDER: "modal",
    })

    expect(realCloudCredentialReason("modal", input, ["modal"])).toBeUndefined()
    expect(realCloudPreflightMissing(env(base), undefined, ["daytona"])).toEqual([])
    expect(realCloudPreflightMissing(input, undefined, ["modal"])).toEqual([])
  })

  test("allows any complete sandbox provider set when no provider is selected", () => {
    const input = env({
      CLERK_SECRET_KEY: "sk_test",
      CLERK_PUBLISHABLE_KEY: "pk_test",
      CLERK_JWT_ISSUER: "https://issuer.example.test",
      CLERK_JWKS_URL: "https://issuer.example.test/.well-known/jwks.json",
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.example.test",
      DAYTONA_API_KEY: "daytona",
    })

    expect(realCloudPreflightMissing(input)).toEqual([])
  })

  test("requires provider credentials in addition to Clerk and Convex", () => {
    const input = env({
      CLERK_SECRET_KEY: "sk_test",
      CLERK_PUBLISHABLE_KEY: "pk_test",
      CLERK_JWT_ISSUER: "https://issuer.example.test",
      CLERK_JWKS_URL: "https://issuer.example.test/.well-known/jwks.json",
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.example.test",
      CLAXEDO_E2E_CLOUD_PROVIDER: "vercel",
      VERCEL_TOKEN: "token",
      VERCEL_TEAM_ID: "team",
    })

    expect(realCloudPreflightMissing(input)).toEqual([
      "VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID",
    ])
  })
})
