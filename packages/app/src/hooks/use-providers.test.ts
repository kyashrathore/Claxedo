import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"

let useProviders: typeof import("./use-providers").useProviders

let sdkDir: string | undefined = "/sdk"
let routeDir = "route"

const global = {
  all: [{ id: "global", models: { "global-model": { id: "global-model", cost: { input: 1 } } } }],
  connected: ["global"],
  default: { global: "global-model" },
}

const byDir: Record<string, any> = {
  "/sdk": {
    provider_ready: true,
    provider: {
      all: [{ id: "sdk", models: { "sdk-model": { id: "sdk-model", cost: { input: 1 } } } }],
      connected: ["sdk"],
      default: { sdk: "sdk-model" },
    },
  },
  "/route": {
    provider_ready: true,
    provider: {
      all: [{ id: "route", models: { "route-model": { id: "route-model", cost: { input: 1 } } } }],
      connected: ["route"],
      default: { route: "route-model" },
    },
  },
}

beforeAll(async () => {
  mock.module("@/context/global-sync", () => ({
    useGlobalSync: () => ({
      data: { provider: global },
      child: (dir: string) => [byDir[dir] ?? { provider_ready: false, provider: global }],
    }),
  }))
  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      if (!sdkDir) throw new Error("missing sdk")
      return { directory: sdkDir }
    },
  }))
  mock.module("@solidjs/router", () => ({
    useParams: () => ({ dir: routeDir }),
  }))
  mock.module("@/utils/base64", () => ({
    decode64: (value?: string) => {
      if (value === "route") return "/route"
      return ""
    },
  }))
  ;({ useProviders } = await import("./use-providers"))
})

describe("useProviders", () => {
  test("prefers the workspace sdk directory over the current route", () => {
    sdkDir = "/sdk"
    routeDir = "route"

    createRoot((dispose) => {
      const providers = useProviders()
      expect(providers.all().map((item) => item.id)).toEqual(["sdk"])
      dispose()
    })
  })

  test("falls back to the route directory when sdk scope is unavailable", () => {
    sdkDir = undefined
    routeDir = "route"

    createRoot((dispose) => {
      const providers = useProviders()
      expect(providers.all().map((item) => item.id)).toEqual(["route"])
      dispose()
    })
  })
})
