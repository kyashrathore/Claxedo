import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { createRoot } from "solid-js"
import { ConfigProvider, useConfig, useConfigOptional } from "./config"
import type { ClaxedoConfig } from "../index"

const config: ClaxedoConfig = {
  convexUrl: "https://convex.test",
  authBaseUrl: "https://auth.test",
  gatewayUrl: "https://gateway.test",
}

afterEach(() => {
  cleanup()
})

describe("ConfigProvider", () => {
  test("provides the Claxedo config to required and optional consumers", () => {
    let required: ClaxedoConfig | undefined
    let optional: ClaxedoConfig | undefined

    function Consumer() {
      required = useConfig()
      optional = useConfigOptional()
      return <span>{required.gatewayUrl}</span>
    }

    render(() => (
      <ConfigProvider config={config}>
        <Consumer />
      </ConfigProvider>
    ))

    expect(screen.getByText("https://gateway.test")).toBeInTheDocument()
    expect(required).toBe(config)
    expect(optional).toBe(config)
  })

  test("distinguishes optional access from required provider access", () => {
    let optional: ClaxedoConfig | undefined

    function OptionalConsumer() {
      optional = useConfigOptional()
      return <span>optional</span>
    }

    render(() => <OptionalConsumer />)
    expect(optional).toBeUndefined()
    expect(() =>
      createRoot((dispose) => {
        try {
          useConfig()
        } finally {
          dispose()
        }
      }),
    ).toThrow("useConfig must be used within ConfigProvider")
  })
})
