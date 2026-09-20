import { describe, expect, test } from "vitest"

import {
  HOST_PROVIDER_CONFIG_VERSION,
  hostProviderConfigProjectAuth,
  parseHostProviderConfig,
  serializeHostProviderConfig,
} from "./host-provider-config"

const PUSHED = {
  baseUrl: "https://model.test",
  placeholder: "sk-pushed",
  authMode: "bearer",
} as const

describe("the sealed payload", () => {
  test("round trips through the shape the control plane writes", () => {
    const text = serializeHostProviderConfig({ openai: PUSHED })
    expect(JSON.parse(text)).toEqual({ version: HOST_PROVIDER_CONFIG_VERSION, providers: { openai: PUSHED } })
    expect(parseHostProviderConfig(text).providers).toEqual({ openai: PUSHED })
  })

  test("an empty configuration is a payload, not an absent one", () => {
    expect(parseHostProviderConfig(serializeHostProviderConfig({})).providers).toEqual({})
  })

  test("a version this host does not know refuses the whole payload and names both versions", () => {
    expect(() => parseHostProviderConfig(JSON.stringify({ version: 2, providers: {} }))).toThrow(/version 2, not 1/)
  })

  test("one unreadable row refuses the whole payload, so a half-applied credential set never reaches a turn", () => {
    const text = JSON.stringify({
      version: 1,
      providers: { openai: PUSHED, anthropic: { baseUrl: "https://a.test", authMode: "nonsense" } },
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
  const broker = async () => ({
    openai: { baseUrl: "https://broker.local", placeholder: "brokered", authMode: "api-key" } as const,
    anthropic: { baseUrl: "https://broker.local", placeholder: "brokered", authMode: "api-key" } as const,
  })

  test("a pushed provider replaces this machine's own answer for that provider alone", async () => {
    const answer = await hostProviderConfigProjectAuth(broker, () => ({ openai: PUSHED }))({})
    expect(answer.openai).toEqual(PUSHED)
    expect(answer.anthropic).toEqual({ baseUrl: "https://broker.local", placeholder: "brokered", authMode: "api-key" })
  })

  test("a withdrawal returns every provider to this machine's own answer", async () => {
    expect(await hostProviderConfigProjectAuth(broker, () => ({}))({})).toEqual(await broker())
  })

  test("a host with no authority of its own answers the pushed rows alone", async () => {
    expect(await hostProviderConfigProjectAuth(undefined, () => ({ openai: PUSHED }))({})).toEqual({ openai: PUSHED })
  })

  test("the pushed rows are read per call, so a revision that lands between turns reaches the next one", async () => {
    let pushed: Record<string, typeof PUSHED> = {}
    const projectAuth = hostProviderConfigProjectAuth(undefined, () => pushed)
    expect(await projectAuth({})).toEqual({})
    pushed = { openai: PUSHED }
    expect(await projectAuth({})).toEqual({ openai: PUSHED })
  })
})
