import { afterEach, describe, expect, test } from "vitest"
import { hostProviderConfigProjectAuth } from "@claxedo/server-core/credentials/host-provider-config"

import {
  clearHostProviderConfig,
  hostProviderConfig,
  hostProviderConfigState,
  installHostProviderConfigRevision,
} from "./host-provider-config"

const PUSHED = { baseUrl: "https://broker.owner.test/bindings/b1", placeholder: "sk-owner-placeholder", authMode: "api-key" as const }
const text = (providers: Record<string, unknown>) => JSON.stringify({ version: 1, providers })

describe("the rows the owner pushed to this machine", () => {
  afterEach(() => {
    clearHostProviderConfig()
  })

  test("holds nothing until a revision is pushed", () => {
    expect(hostProviderConfig()).toEqual({})
    expect(hostProviderConfigState()).toEqual({ revision: null, providerCount: 0 })
  })

  test("a pushed revision replaces the held rows and reports what it holds", () => {
    expect(installHostProviderConfigRevision({ revision: 3, providers: text({ "claude-sdk": PUSHED }) })).toEqual({
      revision: 3,
      providerCount: 1,
    })
    expect(hostProviderConfig()).toEqual({ "claude-sdk": PUSHED })

    installHostProviderConfigRevision({ revision: 4, providers: text({ codex: PUSHED }) })
    expect(hostProviderConfig()).toEqual({ codex: PUSHED })
    expect(hostProviderConfigState()).toEqual({ revision: 4, providerCount: 1 })
  })

  test("the withdrawal is an empty configuration, and it empties what was held", () => {
    installHostProviderConfigRevision({ revision: 3, providers: text({ "claude-sdk": PUSHED }) })
    installHostProviderConfigRevision({ revision: 4, providers: text({}) })
    expect(hostProviderConfig()).toEqual({})
    expect(hostProviderConfigState()).toEqual({ revision: 4, providerCount: 0 })
  })

  test("one unreadable row refuses the whole revision and changes nothing", () => {
    installHostProviderConfigRevision({ revision: 3, providers: text({ "claude-sdk": PUSHED }) })

    expect(() =>
      installHostProviderConfigRevision({ revision: 4, providers: text({ codex: PUSHED, "claude-sdk": { baseUrl: "https://x", authMode: "api-key" } }) }),
    ).toThrow(/cannot read/)
    expect(() => installHostProviderConfigRevision({ revision: 4, providers: "not json" })).toThrow(/not JSON/)
    expect(() => installHostProviderConfigRevision({ revision: 4, providers: JSON.stringify({ version: 2, providers: {} }) })).toThrow(/version 2/)

    expect(hostProviderConfig()).toEqual({ "claude-sdk": PUSHED })
    expect(hostProviderConfigState()).toEqual({ revision: 3, providerCount: 1 })
  })

  test("a caller cannot alter the held rows through the answer", () => {
    installHostProviderConfigRevision({ revision: 3, providers: text({ "claude-sdk": PUSHED }) })
    const answer = hostProviderConfig()
    delete answer["claude-sdk"]
    expect(hostProviderConfig()).toEqual({ "claude-sdk": PUSHED })
  })

  test("composed over a base authority, a pushed provider is answered ahead of the machine's own", async () => {
    const machine = { baseUrl: "http://127.0.0.1/bindings/local", placeholder: "sk-machine", authMode: "api-key" as const }
    const projectAuth = hostProviderConfigProjectAuth(
      async () => ({ "claude-sdk": machine, codex: machine }),
      hostProviderConfig,
    )
    expect(await projectAuth({})).toEqual({ "claude-sdk": machine, codex: machine })

    installHostProviderConfigRevision({ revision: 1, providers: text({ "claude-sdk": PUSHED }) })
    expect(await projectAuth({})).toEqual({ "claude-sdk": PUSHED, codex: machine })

    installHostProviderConfigRevision({ revision: 2, providers: text({}) })
    expect(await projectAuth({})).toEqual({ "claude-sdk": machine, codex: machine })
  })
})
