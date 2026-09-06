import { afterEach, describe, expect, test } from "bun:test"
import { queryKeys } from "@/platform/query/keys"
import { providerListQuery } from "@/platform/query/control-plane"
import { queryClient } from "@/platform/query/query-client"
import { normalizeProviderList } from "@/platform/query/provider-list"

const baseUrl = "http://localhost:4096"

const readerKey = (scope: string | null, harness: string) =>
  providerListQuery({ baseUrl, directory: scope, harnessType: harness }).queryKey

describe("provider catalog cache ownership", () => {
  test("the central runtime's own catalog is one scope among many", () => {
    expect(readerKey(null, "opencode")).toEqual(queryKeys.controlPlane.providers(baseUrl, undefined, "opencode"))
    expect(readerKey(null, "opencode")).not.toEqual(readerKey("/Users/me/project", "opencode"))
  })

  test("different runtimes cannot reuse one harness catalog", () => {
    expect(readerKey("workspace:ws_1", "pi")).not.toEqual(readerKey("workspace:ws_2", "pi"))
    expect(readerKey("workspace:ws_1", "pi")).not.toEqual(readerKey("/Users/me/project", "pi"))
  })

  test("different harnesses cannot reuse one runtime catalog", () => {
    expect(readerKey("workspace:ws_1", "pi")).not.toEqual(readerKey("workspace:ws_1", "claude-acp"))
  })
})

describe("workspace-owned harness catalogs", () => {
  afterEach(() => queryClient.clear())

  const catalog = (providerID: string, modelID: string, name: string) => normalizeProviderList({
    all: [{
      id: providerID,
      name: providerID,
      source: "api",
      env: [],
      options: {},
      models: { [modelID]: { id: modelID, name } },
    }],
    connected: [providerID],
    default: { [providerID]: modelID },
  } as Parameters<typeof normalizeProviderList>[0])

  test("each workspace reads only its authoritative cached Pi catalog", () => {
    const first = catalog("anthropic", "opus", "Opus")
    const second = catalog("openai", "gpt", "GPT")
    queryClient.setQueryData(readerKey("workspace:ws_1", "pi"), first)
    queryClient.setQueryData(readerKey("workspace:ws_2", "pi"), second)

    expect(queryClient.getQueryData(readerKey("workspace:ws_1", "pi"))).toEqual(first)
    expect(queryClient.getQueryData(readerKey("workspace:ws_2", "pi"))).toEqual(second)
    expect(queryClient.getQueryData(readerKey("workspace:ws_3", "pi"))).toBeUndefined()
  })
})
