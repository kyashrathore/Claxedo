import { describe, expect, test } from "vitest"
import type { ResolvedCredentials } from "@claxedo/harness/contract"
import { claudeBundledOptions, codexBundledOptions } from "@claxedo/harness/launch-models"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneCredentials } from "../../authority/services"
import { CursorModelsError, hostedMachineHarnessLaunch, type MachineHarnessDraft } from "./native-launch"

const auth = { mode: "signed", user: { subject: "user_a", tokenIdentifier: "issuer|user_a", issuer: "issuer", orgId: "org_a" } } as SignedControlPlaneAuth
const account = { credentialId: "cred_cursor", providerId: "cursor-sdk" }
const credentials = (patch: Partial<ResolvedCredentials>): ResolvedCredentials =>
  ({ accountOwner: "user_a", machineLoginAllowed: false, providers: {}, secrets: {}, leaseGeneration: "draft", ...patch })
const binding = (authMode: "api-key" | "bearer", withAccount = false) =>
  ({ baseUrl: "https://vendor.example", placeholder: "PLACEHOLDER", authMode, ...(withAccount ? { account } : {}) })
const direct = (authKind: "api-key" | "subscription") =>
  ({ delivery: "direct" as const, baseUrl: "https://vendor.example", secret: "sealed", authKind })

function launch(options: { ready?: boolean; secret?: string | null; fetch?: typeof fetch } = {}) {
  const asked: string[] = []
  const store = {
    getCredential: async (id: string) => (id === account.credentialId ? { id, kind: "api_key" } : undefined),
    resolveCredentialSecretById: async (id: string) => (id === account.credentialId ? ("secret" in options ? options.secret : "key_cursor_secret") : null),
  } as unknown as ControlPlaneCredentials
  const { machineHarnessLaunch } = hostedMachineHarnessLaunch({
    resolveOrgId: async () => "org_a",
    credentials: () => store,
    runtimeReady: async (workspaceId) => {
      asked.push(workspaceId)
      return options.ready === true
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  return { asked, read: (draft: Omit<MachineHarnessDraft, "workspaceId">) => machineHarnessLaunch(auth, { workspaceId: "ws_cloud", ...draft }) }
}

describe("a machine harness draft on a workspace whose runtime is down", () => {
  test("lists Claude Code's models for the account's form, a plan's for a bearer or subscription and a key's otherwise", async () => {
    const { read } = launch()
    expect(await read({ harness: "claude", credentials: credentials({ providers: { anthropic: binding("bearer") } }) })).toEqual(claudeBundledOptions("plan"))
    expect(await read({ harness: "claude", credentials: credentials({ providers: { anthropic: binding("api-key") } }), model: "opus" })).toEqual(claudeBundledOptions("api", "opus"))
    expect(await read({ harness: "claude", credentials: credentials({ direct: { anthropic: direct("subscription") } }) })).toEqual(claudeBundledOptions("plan"))
  })

  test("lists Codex's models for an account delivered to it directly", async () => {
    const { read } = launch()
    expect(await read({ harness: "codex", credentials: credentials({ direct: { openai: direct("api-key") } }), model: "gpt-5.5" })).toEqual(codexBundledOptions("gpt-5.5"))
  })

  test("lists the Cursor account's own models, read from Cursor with its stored key", async () => {
    const requests: { url: string; authorization: string | null }[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") })
      return Response.json({ items: [{ id: "composer-2.5", displayName: "Composer 2.5" }] })
    }) as typeof globalThis.fetch
    const options = await launch({ fetch }).read({ harness: "cursor", credentials: credentials({ providers: { "cursor-sdk": binding("api-key", true) } }) })
    expect(requests).toEqual([{ url: "https://api.cursor.com/v1/models", authorization: "Bearer key_cursor_secret" }])
    expect(options?.options.find((option) => option.category === "model")?.selectOptions?.map((row) => row.id)).toEqual(["auto", "composer-2.5"])
  })

  test("names Cursor's refusal of the read, and lists nothing for a Cursor draft whose account has no stored key", async () => {
    const refusing = (async () => new Response("{}", { status: 401 })) as unknown as typeof globalThis.fetch
    const cursor = { harness: "cursor" as const, credentials: credentials({ providers: { "cursor-sdk": binding("api-key", true) } }) }
    await expect(launch({ fetch: refusing }).read(cursor)).rejects.toThrow(CursorModelsError)
    await expect(launch({ fetch: refusing }).read(cursor)).rejects.toThrow("Cursor refused the model list read (401).")
    expect(await launch({ secret: null, fetch: refusing }).read(cursor)).toBeUndefined()
    expect(await launch({ fetch: refusing }).read({ harness: "cursor", credentials: credentials({ providers: { "cursor-sdk": binding("api-key") } }) })).toBeUndefined()
  })

  test("lists nothing when no account is delivered for the harness", async () => {
    expect(await launch().read({ harness: "claude", credentials: credentials({ providers: { anthropic: { unavailable: true, reason: "account_unavailable" } } }) })).toBeUndefined()
  })
})

test("a draft whose workspace runtime is ready is left to that runtime, and nothing is read for it", async () => {
  const fetch = (async () => { throw new Error("Cursor was asked") }) as unknown as typeof globalThis.fetch
  const { asked, read } = launch({ ready: true, fetch })
  expect(await read({ harness: "cursor", credentials: credentials({ providers: { "cursor-sdk": binding("api-key", true) } }) })).toBeUndefined()
  expect(await read({ harness: "claude", credentials: credentials({ providers: { anthropic: binding("api-key") } }) })).toBeUndefined()
  expect(asked).toEqual(["ws_cloud", "ws_cloud"])
})
