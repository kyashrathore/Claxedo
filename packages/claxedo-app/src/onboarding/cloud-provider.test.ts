/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { SandboxListing } from "@/accounts"
import type { Account } from "@/server"
import { providerInUse, providerRows } from "./cloud-provider"
import type { OnboardingText } from "./i18n"

const t = ((key: string, params?: Readonly<Record<string, string>>) => (params ? `${key} ${JSON.stringify(params)}` : key)) as OnboardingText
const drivers = [
  { id: "boat", label: "Boat", fields: [] },
  { id: "cloudflare", label: "Cloudflare", fields: [] },
]
const key = (providerId: string) => ({ id: `key_${providerId}`, providerId, kind: "sandbox_driver", source: "managed", active: true, hasSecret: true }) as Account
const listing = (keys: readonly Account[], defaultDriver?: string): SandboxListing => ({ kind: "listed", drivers, keys, canManage: true, machineClasses: [], ...(defaultDriver ? { defaultDriver } : {}) })

test("with no key there is no row; with keys, one row per keyed provider", () => {
  expect(providerRows(t, listing([]))).toEqual([])
  expect(providerRows(t, listing([key("cloudflare"), key("cloudflare"), key("boat")], "cloudflare"))).toEqual([
    { id: "cloudflare", title: 'onboarding.cloud.key {"provider":"Cloudflare"}', detail: "onboarding.cloud.key.detail" },
    { id: "boat", title: 'onboarding.cloud.key {"provider":"Boat"}', detail: "onboarding.cloud.key.detail" },
  ])
})

test("a reader who may not manage keys is told the provider in use, or that an admin has to add one", () => {
  expect(providerInUse(t, listing([]))).toBe("onboarding.cloud.fixed.none")
  expect(providerInUse(t, listing([key("boat")], "boat"))).toBe('onboarding.cloud.fixed {"provider":"Boat"}')
})
