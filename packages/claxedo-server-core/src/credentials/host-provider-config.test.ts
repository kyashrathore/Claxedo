import { describe, expect, test } from "vitest"
import type { CredentialSnapshot } from "@claxedo/agent-runtime-contract"

import {
  HOST_PROVIDER_CONFIG_VERSION,
  hostProviderConfigProjectAuth,
  parseHostProviderConfig,
  serializeHostProviderConfig,
} from "./host-provider-config"

const snapshot = <T>(providers: Record<string, T>) => ({ machineOwnerUserId: "local", accounts: { local: providers } })

const PUSHED = {
  baseUrl: "https://model.test",
  placeholder: "sk-pushed",
  authMode: "bearer",
} as const

describe("the sealed payload", () => {
  test("round trips through the shape the control plane writes", () => {
    const text = serializeHostProviderConfig({ openai: PUSHED }, "local")
    expect(JSON.parse(text)).toEqual({ version: HOST_PROVIDER_CONFIG_VERSION, credentials: snapshot({ openai: PUSHED }) })
    expect(parseHostProviderConfig(text).credentials.accounts.local).toEqual({ openai: PUSHED })
  })

  test("an empty configuration is a payload, not an absent one", () => {
    expect(parseHostProviderConfig(serializeHostProviderConfig({}, "local")).credentials.accounts.local).toEqual({})
  })

  test("a version this host does not know refuses the whole payload and names both versions", () => {
    expect(() => parseHostProviderConfig(JSON.stringify({ version: 2, providers: {} }))).toThrow(/version 2, not 1/)
  })

  test("one unreadable row refuses the whole payload, so a half-applied credential set never reaches a turn", () => {
    const text = JSON.stringify({
      version: 1,
      credentials: snapshot({ openai: PUSHED, anthropic: { baseUrl: "https://a.test", authMode: "nonsense" } }),
    })
    expect(() => parseHostProviderConfig(text)).toThrow(/cannot read/)
  })

  test.each([
    ["not json at all", /not JSON/],
    ['"a string"', /must be a JSON object/],
    ["[]", /must be a JSON object/],
    ['{"version":1}', /cannot read/],
  ])("%s is refused", (text, message) => {
    expect(() => parseHostProviderConfig(text)).toThrow(message)
  })
})

describe("what a host answers once a configuration is pushed", () => {
  const brokered = { baseUrl: "https://broker.local", placeholder: "brokered", authMode: "api-key" } as const
  const broker = async () => ({ machineOwnerUserId: "owner", accounts: { owner: { openai: brokered, anthropic: brokered } } })
  const pushedBy = (person: string): CredentialSnapshot => JSON.parse(serializeHostProviderConfig({ openai: PUSHED }, person)).credentials

  test("the enrolled owner's pushed provider replaces this machine's own answer for that provider alone", async () => {
    const answer = await hostProviderConfigProjectAuth(broker, () => pushedBy("owner"), () => "owner", () => ({}))({})
    expect(answer.accounts.owner).toEqual({ openai: PUSHED, anthropic: brokered })
  })

  test("a provider the owner chose the org account for keeps it over their pushed account", async () => {
    const org = { baseUrl: "https://broker.local", placeholder: "org", authMode: "api-key" } as const
    const base = async () => ({ machineOwnerUserId: "owner", accounts: { owner: { openai: org, anthropic: brokered } } })
    const answer = await hostProviderConfigProjectAuth(base, () => pushedBy("owner"), () => "owner", () => ({ openai: "org" }))({})
    expect(answer.accounts.owner).toEqual({ openai: org, anthropic: brokered })
  })

  test("a push from anyone but the enrolled owner is an earlier enrollment's and answers for nobody", async () => {
    expect(await hostProviderConfigProjectAuth(broker, () => pushedBy("earlier-owner"), () => "owner", () => ({}))({})).toEqual(await broker())
  })

  test("before an owner is enrolled a push is held but not spent", async () => {
    expect(await hostProviderConfigProjectAuth(broker, () => pushedBy("owner"), () => undefined, () => ({}))({})).toEqual(await broker())
  })

  test("a withdrawal returns every provider to this machine's own answer", async () => {
    expect(await hostProviderConfigProjectAuth(broker, () => undefined, () => "owner", () => ({}))({})).toEqual(await broker())
  })

  test("a host with no authority of its own answers the enrolled owner's pushed rows alone", async () => {
    expect(await hostProviderConfigProjectAuth(undefined, () => pushedBy("owner"), () => "owner", () => ({}))({}))
      .toEqual({ machineOwnerUserId: "owner", accounts: { owner: { openai: PUSHED } } })
  })

  test("the pushed rows are read per call, so a revision that lands between turns reaches the next one", async () => {
    let pushed: CredentialSnapshot | undefined
    const projectAuth = hostProviderConfigProjectAuth(undefined, () => pushed, () => "owner", () => ({}))
    expect(await projectAuth({})).toEqual({ machineOwnerUserId: "owner", accounts: {} })
    pushed = pushedBy("owner")
    expect(await projectAuth({})).toEqual({ machineOwnerUserId: "owner", accounts: { owner: { openai: PUSHED } } })
  })

  test("the owner's direct rows reach only the owner, and a provider they chose the org account for keeps none", async () => {
    const plan = { delivery: "direct", baseUrl: "https://chatgpt.com", secret: "plan-token", authKind: "subscription" } as const
    const key = { delivery: "direct", baseUrl: "https://api.openai.com", secret: "sk-owner", authKind: "api-key" } as const
    const pushed = (): CredentialSnapshot => JSON.parse(serializeHostProviderConfig({ openai: PUSHED }, "owner", { "codex-app-server": plan, openai: key })).credentials
    expect(parseHostProviderConfig(serializeHostProviderConfig({}, "owner", { "codex-app-server": plan })).credentials.direct).toEqual({ owner: { "codex-app-server": plan } })
    const answer = await hostProviderConfigProjectAuth(broker, pushed, () => "owner", () => ({ openai: "org" }))({})
    expect(answer.direct).toEqual({ owner: { "codex-app-server": plan } })
    expect(Object.keys(answer.direct ?? {})).toEqual(["owner"])
  })
})
