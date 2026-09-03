import { afterEach, describe, expect, test } from "bun:test"
import { queryKeys } from "@/platform/query/keys"
import { providerListQuery } from "@/platform/query/control-plane"
import { queryClient } from "@/platform/query/query-client"
import { normalizeProviderList } from "@/platform/query/provider-list"

const baseUrl = "http://localhost:4096"

const emptyClient = {
  provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
}

const readerKey = (scope: string | null, harness: string) =>
  providerListQuery({ baseUrl, client: emptyClient, directory: scope, harnessType: harness }).queryKey

describe("provider catalog cache ownership", () => {
  test("the central runtime's own catalog is one scope among many", () => {
    expect(readerKey(null, "opencode")).toEqual(queryKeys.controlPlane.providers(baseUrl, undefined, "opencode"))
    expect(readerKey(null, "opencode")).not.toEqual(readerKey("/Users/me/project", "opencode"))
  })

  test("two panes for one harness runtime share one catalog", () => {
    expect(readerKey("workspace:ws_1", "pi")).toEqual(readerKey("workspace:ws_1", "pi"))
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

  const resolveLabel = (scope: string, pick: { providerID: string; modelID: string }) => {
    const data = queryClient.getQueryData<ReturnType<typeof catalog>>(readerKey(scope, "pi"))
    if (!data) return undefined
    const connected = new Set(data.connected)
    return [...data.all.values()]
      .filter((provider) => connected.has(provider.id))
      .flatMap((provider) => Object.values(provider.models).map((model) => ({ ...model, provider })))
      .find((model) => model.id === pick.modelID && model.provider.id === pick.providerID)
      ?.name
  }

  test("each workspace resolves only its authoritative Pi model", () => {
    queryClient.setQueryData(readerKey("workspace:ws_1", "pi"), catalog("anthropic", "opus", "Opus"))
    queryClient.setQueryData(readerKey("workspace:ws_2", "pi"), catalog("openai", "gpt", "GPT"))

    expect(resolveLabel("workspace:ws_1", { providerID: "anthropic", modelID: "opus" })).toBe("Opus")
    expect(resolveLabel("workspace:ws_1", { providerID: "openai", modelID: "gpt" })).toBeUndefined()
    expect(resolveLabel("workspace:ws_2", { providerID: "openai", modelID: "gpt" })).toBe("GPT")
  })
})
