/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { Capabilities, Server } from "@/server"
import { prefetchOnboardingReads } from "./prefetch"

function fakeServer() {
  const prefetched: string[] = []
  const query = (read: string) => ({ read })
  const server = {
    queryClient: { prefetchQuery: async (options: { read: string }) => void prefetched.push(options.read) },
    queries: {
      accounts: { list: () => query("accounts"), effective: () => query("effective"), sources: () => query("sources"), sandbox: () => query("sandbox") },
      integrations: { codeHosts: () => query("code-hosts"), catalog: () => query("integrations") },
    },
  } as unknown as Server
  return { server, prefetched }
}

const capabilities = (servingMachine: boolean, connections: boolean) =>
  ({ servingMachine: servingMachine ? { name: "laptop" } : undefined, features: { connections } }) as unknown as Capabilities

test("a hosted plane's route starts the Where step's sandbox listing, the Project step's code hosts and the AI step's accounts before its chunk lands", () => {
  const { server, prefetched } = fakeServer()
  prefetchOnboardingReads(server, capabilities(false, true))
  expect(prefetched).toEqual(["accounts", "effective", "sources", "sandbox", "code-hosts"])
})

test("a hosted plane without connections reads no code hosts", () => {
  const { server, prefetched } = fakeServer()
  prefetchOnboardingReads(server, capabilities(false, false))
  expect(prefetched).toEqual(["accounts", "effective", "sources", "sandbox"])
})

test("a desktop reads only the accounts its AI step shows", () => {
  const { server, prefetched } = fakeServer()
  prefetchOnboardingReads(server, capabilities(true, true))
  expect(prefetched).toEqual(["accounts", "effective", "sources"])
})
