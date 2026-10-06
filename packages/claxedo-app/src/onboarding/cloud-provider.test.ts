/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { SandboxListing } from "@/accounts"
import type { Account } from "@/server"
import { providerInUse, providerRows } from "./cloud-provider"
import type { OnboardingText } from "./i18n"

const t = ((key: string, params?: Readonly<Record<string, string>>) => (params ? `${key} ${JSON.stringify(params)}` : key)) as OnboardingText
const drivers = [
  { id: "boat", label: "Boat", fields: [] },
  { id: "modal", label: "Modal", fields: [] },
]
const key = (providerId: string) => ({ id: `key_${providerId}`, providerId, kind: "sandbox_driver", source: "managed", active: true, hasSecret: true }) as Account
const listing = (keys: readonly Account[], defaultDriver?: string): SandboxListing => ({ kind: "listed", drivers, keys, canManage: true, managedDriver: "boat", machineClasses: [], ...(defaultDriver ? { defaultDriver } : {}) })

test("with no key the one row is the deployment's managed provider; with keys, one row per keyed provider and the managed one is gone", () => {
  expect(providerRows(t, listing([]))).toEqual([{ id: "boat", title: "onboarding.cloud.managed", detail: 'onboarding.cloud.managed.detail {"provider":"Boat"}', keyed: false }])
  expect(providerRows(t, listing([key("modal"), key("modal"), key("boat")], "modal"))).toEqual([
    { id: "modal", title: 'onboarding.cloud.key {"provider":"Modal"}', detail: "onboarding.cloud.key.detail", keyed: true },
    { id: "boat", title: 'onboarding.cloud.key {"provider":"Boat"}', detail: "onboarding.cloud.key.detail", keyed: true },
  ])
})

test("a reader who may not manage keys is told the provider in use, their own account's name when it is a key", () => {
  expect(providerInUse(t, listing([]))).toBe("onboarding.cloud.managed")
  expect(providerInUse(t, listing([], "boat"))).toBe("onboarding.cloud.managed")
  expect(providerInUse(t, listing([], "modal"))).toBe('onboarding.cloud.key {"provider":"Modal"}')
})
