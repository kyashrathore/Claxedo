import { describe, expect, test } from "bun:test"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import {
  createResolverClient,
  createCachedRevocationClient,
  installFatalProcessHandlers,
  installShutdownDrainHandler,
  loadRelayHostKeyMaterial,
  loadRuntimeAccessKeyOrJwks,
  directHttpConcurrencyFromEnv,
  parseAuditAcceptSampleRate,
  parseMetricsToken,
  resolverClientCacheOptionsFromEnv,
  runtimeAccessTokenCacheTtlMsFromEnv,
  validateProductionEnv,
} from "./main"
import { createWorkspaceRelayDirectory } from "./directory"
import {
  checkHostTunnelGeneration,
  createCachedHostGenerationClient,
  createCachedTargetClient,
  createHostGenerationResolverLookup,
  hostTunnelIncumbentOutranks,
  parseHostGenerationResult,
  type HostGenerationResult,
  type RuntimeAccessTokenActiveResult,
  type WorkspaceRelayTarget,
} from "./server"

type Args = { jti: string; workspaceId: string; hostId: string }

function makeFakeNow(start = 0) {
  let value = start
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms
    },
    set: (v: number) => {
      value = v
    },
  }
}

describe("createCachedRevocationClient", () => {
  test("first call queries the underlying resolver", async () => {
    const calls: Args[] = []
    const inner = async (args: Args): Promise<RuntimeAccessTokenActiveResult> => {
      calls.push(args)
      return { active: true }
    }
    const cached = createCachedRevocationClient(inner)

    const result = await cached({ jti: "jti_1", workspaceId: "ws_1", hostId: "host_1" })
    expect(result).toEqual({ active: true })
    expect(calls.length).toBe(1)
  })

  test("returns the resolver's response shape verbatim", async () => {
    const inner = async (): Promise<RuntimeAccessTokenActiveResult> => ({
      active: false,
      code: "runtime_access_token_revoked",
      reason: "Runtime Access Token has been revoked",
    })
    const cached = createCachedRevocationClient(inner)
    const result = await cached({ jti: "jti_x", workspaceId: "ws_1", hostId: "host_1" })
    expect(result).toEqual({
      active: false,
      code: "runtime_access_token_revoked",
      reason: "Runtime Access Token has been revoked",
    })
  })

  test("second call within TTL returns cached result without re-querying", async () => {
    let calls = 0
    const clock = makeFakeNow(1_000_000)
    const inner = async (): Promise<RuntimeAccessTokenActiveResult> => {
      calls++
      return { active: true }
    }
    const cached = createCachedRevocationClient(inner, { ttlMs: 10_000, now: clock.now })

    await cached({ jti: "jti_1", workspaceId: "ws_1", hostId: "host_1" })
    expect(calls).toBe(1)

    clock.advance(5_000)
    const result = await cached({ jti: "jti_1", workspaceId: "ws_1", hostId: "host_1" })
    expect(result).toEqual({ active: true })
    expect(calls).toBe(1)
  })

  test("call after TTL elapses re-queries", async () => {
    let calls = 0
    const clock = makeFakeNow(1_000_000)
    const inner = async (): Promise<RuntimeAccessTokenActiveResult> => {
      calls++
      return { active: true }
    }
    const cached = createCachedRevocationClient(inner, { ttlMs: 10_000, now: clock.now })

    await cached({ jti: "jti_1", workspaceId: "ws_1", hostId: "host_1" })
    expect(calls).toBe(1)

    clock.advance(10_001)
    await cached({ jti: "jti_1", workspaceId: "ws_1", hostId: "host_1" })
    expect(calls).toBe(2)
  })

  test("negative results are also cached for the TTL", async () => {
    let calls = 0
    const clock = makeFakeNow(1_000_000)
    const inner = async (): Promise<RuntimeAccessTokenActiveResult> => {
      calls++
      return {
        active: false,
        code: "runtime_access_token_revoked",
        reason: "revoked",
      }
    }
    const cached = createCachedRevocationClient(inner, { ttlMs: 10_000, now: clock.now })

    const first = await cached({ jti: "jti_revoked", workspaceId: "ws_1", hostId: "host_1" })
    expect(first).toEqual({
      active: false,
      code: "runtime_access_token_revoked",
      reason: "revoked",
    })
    expect(calls).toBe(1)

    clock.advance(9_999)
    const second = await cached({ jti: "jti_revoked", workspaceId: "ws_1", hostId: "host_1" })
    expect(second).toEqual({
      active: false,
      code: "runtime_access_token_revoked",
      reason: "revoked",
    })
    expect(calls).toBe(1)
  })

  test("cache is keyed by jti", async () => {
    let calls = 0
    const clock = makeFakeNow(1_000_000)
    const inner = async (): Promise<RuntimeAccessTokenActiveResult> => {
      calls++
      return { active: true }
    }
    const cached = createCachedRevocationClient(inner, { ttlMs: 10_000, now: clock.now })

    await cached({ jti: "jti_a", workspaceId: "ws_1", hostId: "host_1" })
    await cached({ jti: "jti_b", workspaceId: "ws_1", hostId: "host_1" })
    expect(calls).toBe(2)

    await cached({ jti: "jti_a", workspaceId: "ws_1", hostId: "host_1" })
    await cached({ jti: "jti_b", workspaceId: "ws_1", hostId: "host_1" })
    expect(calls).toBe(2)
  })

  test("concurrent misses share one underlying revocation lookup", async () => {
    let calls = 0
    let resolve!: (result: RuntimeAccessTokenActiveResult) => void
    const inner = async (): Promise<RuntimeAccessTokenActiveResult> => {
      calls++
      return await new Promise((done) => {
        resolve = done
      })
    }
    const cached = createCachedRevocationClient(inner)
    const first = cached({ jti: "jti_1", workspaceId: "ws_1", hostId: "host_1" })
    const second = cached({ jti: "jti_1", workspaceId: "ws_1", hostId: "host_1" })
    resolve({ active: true })
    await expect(Promise.all([first, second])).resolves.toEqual([{ active: true }, { active: true }])
    expect(calls).toBe(1)
  })

  test("evicts old revocation entries when the cache reaches its size bound", async () => {
    let calls = 0
    const clock = makeFakeNow(1_000_000)
    const cached = createCachedRevocationClient(async (): Promise<RuntimeAccessTokenActiveResult> => {
      calls++
      return { active: true }
    }, { ttlMs: 10_000, now: clock.now })

    for (let index = 0; index <= 8_192; index++) {
      await cached({ jti: `jti_${index}`, workspaceId: "ws_1", hostId: "host_1" })
    }
    await cached({ jti: "jti_0", workspaceId: "ws_1", hostId: "host_1" })

    expect(calls).toBe(8_194)
  })
})

describe("createCachedTargetClient", () => {
  const target: WorkspaceRelayTarget = {
    workspaceId: "ws_1",
    hostId: "host_1",
    baseUrl: "https://runtime.test",
    access: "cloud",
    backing: "cloud-vm",
  }

  test("caches positive target lookups by workspace and host", async () => {
    let calls = 0
    const clock = makeFakeNow(1_000_000)
    const cached = createCachedTargetClient(async () => {
      calls++
      return target
    }, { ttlMs: 5_000, now: clock.now })

    await expect(cached({ workspaceId: "ws_1", hostId: "host_1" })).resolves.toEqual(target)
    await expect(cached({ workspaceId: "ws_1", hostId: "host_1" })).resolves.toEqual(target)
    expect(calls).toBe(1)

    clock.advance(5_001)
    await expect(cached({ workspaceId: "ws_1", hostId: "host_1" })).resolves.toEqual(target)
    expect(calls).toBe(2)
  })

  test("does not retain missing targets after the in-flight lookup completes", async () => {
    let calls = 0
    const cached = createCachedTargetClient(async () => {
      calls++
      return undefined
    })

    await expect(cached({ workspaceId: "ws_missing", hostId: "host_1" })).resolves.toBeUndefined()
    await expect(cached({ workspaceId: "ws_missing", hostId: "host_1" })).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })

  test("concurrent target misses share one underlying lookup", async () => {
    let calls = 0
    let resolve!: (result: WorkspaceRelayTarget) => void
    const cached = createCachedTargetClient(async () => {
      calls++
      return await new Promise<WorkspaceRelayTarget>((done) => {
        resolve = done
      })
    })
    const first = cached({ workspaceId: "ws_1", hostId: "host_1" })
    const second = cached({ workspaceId: "ws_1", hostId: "host_1" })
    resolve(target)
    await expect(Promise.all([first, second])).resolves.toEqual([target, target])
    expect(calls).toBe(1)
  })

  test("evicts old target entries when the cache reaches its size bound", async () => {
    let calls = 0
    const clock = makeFakeNow(1_000_000)
    const cached = createCachedTargetClient(async () => {
      calls++
      return target
    }, { ttlMs: 10_000, now: clock.now })

    for (let index = 0; index <= 8_192; index++) {
      await cached({ workspaceId: `ws_${index}`, hostId: "host_1" })
    }
    await cached({ workspaceId: "ws_0", hostId: "host_1" })

    expect(calls).toBe(8_194)
  })
})

describe("createResolverClient", () => {
  const target: WorkspaceRelayTarget = {
    workspaceId: "ws_1",
    hostId: "host_1",
    baseUrl: "https://runtime.test",
    access: "cloud",
    backing: "cloud-vm",
  }

  test("caches positive target resolver responses by workspace and host", async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: URL; authorization: string | null }> = []
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      })
      return new Response(JSON.stringify(target), {
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    try {
      const client = createResolverClient("https://resolver.test/", "resolver_token", { targetCacheTtlMs: 10_000 })
      await expect(client.target("ws_1", "host_1")).resolves.toEqual(target)
      await expect(client.target("ws_1", "host_1")).resolves.toEqual(target)

      expect(requests.length).toBe(1)
      expect(requests[0]?.url.pathname).toBe("/target")
      expect(requests[0]?.url.searchParams.get("workspaceId")).toBe("ws_1")
      expect(requests[0]?.url.searchParams.get("hostId")).toBe("host_1")
      expect(requests[0]?.authorization).toBe("Bearer resolver_token")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("resolverClientCacheOptionsFromEnv", () => {
  test("uses secure production defaults and accepts positive overrides", () => {
    expect(resolverClientCacheOptionsFromEnv({})).toEqual({
      targetCacheTtlMs: 30_000,
      revocationCacheTtlMs: 10_000,
      hostGenerationCacheTtlMs: 10_000,
    })
    expect(resolverClientCacheOptionsFromEnv({
      CLAXEDO_RELAY_TARGET_CACHE_TTL_MS: "15000",
      CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS: "5000",
    })).toEqual({
      targetCacheTtlMs: 15_000,
      revocationCacheTtlMs: 5_000,
      hostGenerationCacheTtlMs: 10_000,
    })
  })

  test("carries the host-generation URL only as an explicit override, and its cache TTL always", () => {
    expect(resolverClientCacheOptionsFromEnv({
      CLAXEDO_RELAY_HOST_GENERATION_CACHE_TTL_MS: "2000",
    })).toEqual({
      targetCacheTtlMs: 30_000,
      revocationCacheTtlMs: 10_000,
      hostGenerationCacheTtlMs: 2_000,
    })
    expect(resolverClientCacheOptionsFromEnv({
      CLAXEDO_RELAY_HOST_GENERATION_URL: " https://central.test/internal/relay/host-generation ",
    })).toEqual({
      targetCacheTtlMs: 30_000,
      revocationCacheTtlMs: 10_000,
      hostGenerationUrl: "https://central.test/internal/relay/host-generation",
      hostGenerationCacheTtlMs: 10_000,
    })
  })
})

describe("createResolverClient host generation", () => {
  function withFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => await handler(
      new URL(input instanceof Request ? input.url : String(input)),
      init,
    )) as typeof fetch
    return () => {
      globalThis.fetch = originalFetch
    }
  }

  test("derives the lookup from the resolver base and sends the enrollment id with the relay bearer", async () => {
    const requests: Array<{ url: URL; authorization: string | null }> = []
    const restore = withFetch((url, init) => {
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") })
      return Response.json({ enrollmentId: "enr_1", generation: 3, revoked: false })
    })
    try {
      const client = createResolverClient("https://resolver.test/internal/relay/", "resolver_token")
      await expect(client.hostGeneration({ enrollmentId: "enr_1", generation: 3 }))
        .resolves.toEqual({ enrollmentId: "enr_1", generation: 3, revoked: false })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url.href).toBe("https://resolver.test/internal/relay/host-generation?enrollmentId=enr_1")
      expect(requests[0]?.authorization).toBe("Bearer resolver_token")
    } finally {
      restore()
    }
  })

  test("an explicit URL overrides the derived one", async () => {
    const requests: URL[] = []
    const restore = withFetch((url) => {
      requests.push(url)
      return Response.json({ enrollmentId: "enr_1", generation: 3, revoked: false })
    })
    try {
      const client = createResolverClient("https://resolver.test/internal/relay", "resolver_token", {
        hostGenerationUrl: "https://central.test/other/host-generation",
      })
      await client.hostGeneration({ enrollmentId: "enr_1", generation: 3 })
      expect(requests.map((url) => url.href)).toEqual(["https://central.test/other/host-generation?enrollmentId=enr_1"])
    } finally {
      restore()
    }
  })

  test("resolves undefined only on the control plane's enrollment-not-found 404; a bare 404 or any other failure throws", async () => {
    let response = () => Response.json({ error: { code: "relay_resolver_enrollment_not_found", message: "Enrollment not found" } }, { status: 404 })
    const restore = withFetch(() => response())
    try {
      const client = createResolverClient("https://resolver.test/internal/relay", "resolver_token")
      await expect(client.hostGeneration({ enrollmentId: "enr_1", generation: 1 })).resolves.toBeUndefined()
      response = () => new Response("404 Not Found", { status: 404 })
      await expect(client.hostGeneration({ enrollmentId: "enr_1", generation: 1 }))
        .rejects.toThrow("relay host-generation resolver failed: 404 (no host-generation route at https://resolver.test/internal/relay/host-generation)")
      response = () => new Response("boom", { status: 503 })
      await expect(client.hostGeneration({ enrollmentId: "enr_1", generation: 1 }))
        .rejects.toThrow("relay host-generation resolver failed: 503 boom")
    } finally {
      restore()
    }
  })

  test("throws on a malformed body instead of trusting it", async () => {
    const restore = withFetch(() => Response.json({ enrollmentId: "enr_1", generation: "3" }))
    try {
      const client = createResolverClient("https://resolver.test/internal/relay", "resolver_token")
      await expect(client.hostGeneration({ enrollmentId: "enr_1", generation: 3 }))
        .rejects.toThrow("malformed result")
    } finally {
      restore()
    }
  })

  test("bounds every lookup with a 5 s deadline by default and rejects when it passes", async () => {
    const signals: Array<AbortSignal | null | undefined> = []
    const lookup = createHostGenerationResolverLookup("https://resolver.test/internal/relay/host-generation", {
      headers: {},
      fetch: (_url, init) => {
        signals.push(init.signal)
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        })
      },
      timeoutMs: 20,
    })
    await expect(lookup({ enrollmentId: "enr_1", generation: 1 })).rejects.toThrow(/timed out|TimeoutError/i)
    expect(signals[0]).toBeInstanceOf(AbortSignal)

    const defaults: Array<AbortSignal | null | undefined> = []
    const defaultLookup = createHostGenerationResolverLookup("https://resolver.test/internal/relay/host-generation", {
      headers: {},
      fetch: async (_url, init) => {
        defaults.push(init.signal)
        return Response.json({ enrollmentId: "enr_1", generation: 1, revoked: false })
      },
    })
    await defaultLookup({ enrollmentId: "enr_1", generation: 1 })
    expect(defaults[0]).toBeInstanceOf(AbortSignal)
    expect(defaults[0]?.aborted).toBe(false)
  })

  test("a hit deadline is graded as an unavailable lookup", async () => {
    const lookup = createHostGenerationResolverLookup("https://resolver.test/internal/relay/host-generation", {
      headers: {},
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      }),
      timeoutMs: 20,
    })
    await expect(checkHostTunnelGeneration(lookup, { enrollment_id: "enr_1", generation: 1 })).resolves.toMatchObject({
      ok: false,
      retryable: true,
      code: "host_generation_lookup_unavailable",
    })
  })
})

describe("hostTunnelIncumbentOutranks", () => {
  test("a fenced incumbent yields only to an equal or higher generation; an unfenced one yields to anyone", () => {
    expect(hostTunnelIncumbentOutranks(3, 2)).toBe(true)
    expect(hostTunnelIncumbentOutranks(3, undefined)).toBe(true)
    expect(hostTunnelIncumbentOutranks(3, 3)).toBe(false)
    expect(hostTunnelIncumbentOutranks(3, 4)).toBe(false)
    expect(hostTunnelIncumbentOutranks(undefined, undefined)).toBe(false)
    expect(hostTunnelIncumbentOutranks(undefined, 0)).toBe(false)
  })
})

describe("parseHostGenerationResult", () => {
  test("accepts the route's shape and rejects everything else", () => {
    expect(parseHostGenerationResult({ enrollmentId: "enr_1", generation: 0, revoked: false }))
      .toEqual({ enrollmentId: "enr_1", generation: 0, revoked: false })
    expect(parseHostGenerationResult({ enrollmentId: "enr_1", generation: 2, revoked: true }))
      .toEqual({ enrollmentId: "enr_1", generation: 2, revoked: true })
    for (const input of [
      undefined,
      null,
      "enr_1",
      { enrollmentId: "", generation: 1, revoked: false },
      { enrollmentId: "enr_1", generation: -1, revoked: false },
      { enrollmentId: "enr_1", generation: 1.5, revoked: false },
      { enrollmentId: "enr_1", generation: "1", revoked: false },
      { enrollmentId: "enr_1", generation: 1 },
      { enrollmentId: "enr_1", generation: 1, revoked: "no" },
    ]) {
      expect(parseHostGenerationResult(input)).toBeUndefined()
    }
  })
})

describe("createCachedHostGenerationClient", () => {
  type Args = { enrollmentId: string; generation: number }
  function current(generation: number, revoked = false): HostGenerationResult {
    return { enrollmentId: "enr_1", generation, revoked }
  }

  test("serves a cached answer that equals the caller's generation", async () => {
    const calls: Args[] = []
    const clock = makeFakeNow(1_000_000)
    const cached = createCachedHostGenerationClient(async (args) => {
      calls.push(args)
      return current(3)
    }, { ttlMs: 10_000, now: clock.now })

    await expect(cached({ enrollmentId: "enr_1", generation: 3 })).resolves.toEqual(current(3))
    clock.advance(5_000)
    await expect(cached({ enrollmentId: "enr_1", generation: 3 })).resolves.toEqual(current(3))
    expect(calls).toHaveLength(1)

    clock.advance(5_001)
    await cached({ enrollmentId: "enr_1", generation: 3 })
    expect(calls).toHaveLength(2)
  })

  test("a caller with a higher generation than the cache forces a refresh", async () => {
    let live = 3
    const calls: Args[] = []
    const clock = makeFakeNow(1_000_000)
    const cached = createCachedHostGenerationClient(async (args) => {
      calls.push(args)
      return current(live)
    }, { ttlMs: 10_000, now: clock.now })

    await cached({ enrollmentId: "enr_1", generation: 3 })
    live = 4
    clock.advance(1_000)
    // A freshly acquired generation must never be refused on the stale entry.
    await expect(cached({ enrollmentId: "enr_1", generation: 4 })).resolves.toEqual(current(4))
    expect(calls).toHaveLength(2)
    // The refreshed answer is now the cached one.
    await expect(cached({ enrollmentId: "enr_1", generation: 4 })).resolves.toEqual(current(4))
    expect(calls).toHaveLength(2)
  })

  test("a caller with a lower generation than the cache is answered from the cache", async () => {
    let calls = 0
    const clock = makeFakeNow(1_000_000)
    const cached = createCachedHostGenerationClient(async () => {
      calls += 1
      return current(4)
    }, { ttlMs: 10_000, now: clock.now })

    await cached({ enrollmentId: "enr_1", generation: 4 })
    await expect(cached({ enrollmentId: "enr_1", generation: 2 })).resolves.toEqual(current(4))
    expect(calls).toBe(1)
  })

  test("a revoked answer is cached as any other conclusive answer", async () => {
    let calls = 0
    const cached = createCachedHostGenerationClient(async () => {
      calls += 1
      return current(2, true)
    }, { ttlMs: 10_000, now: makeFakeNow(1_000_000).now })

    await expect(cached({ enrollmentId: "enr_1", generation: 2 })).resolves.toEqual(current(2, true))
    await expect(cached({ enrollmentId: "enr_1", generation: 2 })).resolves.toEqual(current(2, true))
    expect(calls).toBe(1)
  })

  test("unknown enrollments and failures are not cached", async () => {
    let calls = 0
    let mode: "unknown" | "throw" | "ok" = "unknown"
    const cached = createCachedHostGenerationClient(async () => {
      calls += 1
      if (mode === "unknown") return undefined
      if (mode === "throw") throw new Error("resolver down")
      return current(1)
    }, { ttlMs: 10_000, now: makeFakeNow(1_000_000).now })

    await expect(cached({ enrollmentId: "enr_1", generation: 1 })).resolves.toBeUndefined()
    await expect(cached({ enrollmentId: "enr_1", generation: 1 })).resolves.toBeUndefined()
    expect(calls).toBe(2)
    mode = "throw"
    await expect(cached({ enrollmentId: "enr_1", generation: 1 })).rejects.toThrow("resolver down")
    mode = "ok"
    await expect(cached({ enrollmentId: "enr_1", generation: 1 })).resolves.toEqual(current(1))
    expect(calls).toBe(4)
  })

  test("a caller above an in-flight lookup's answer refreshes after it settles instead of inheriting it", async () => {
    let live = 3
    const calls: Args[] = []
    let release: (() => void) | undefined
    const cached = createCachedHostGenerationClient(async (args) => {
      calls.push(args)
      const answer = current(live)
      if (calls.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return answer
    }, { ttlMs: 60_000 })

    const first = cached({ enrollmentId: "enr_1", generation: 3 })
    await new Promise((resolve) => setTimeout(resolve, 1))
    // The control plane advances while the first lookup is still in flight;
    // the caller holding the new generation must not be answered with 3.
    live = 4
    const second = cached({ enrollmentId: "enr_1", generation: 4 })
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(calls).toHaveLength(1)
    release?.()
    await expect(first).resolves.toEqual(current(3))
    await expect(second).resolves.toEqual(current(4))
    expect(calls.map((args) => args.generation)).toEqual([3, 4])
    await expect(checkHostTunnelGeneration(cached, { enrollment_id: "enr_1", generation: 4 })).resolves.toEqual({ ok: true })
    expect(calls).toHaveLength(2)
  })

  test("concurrent misses share one lookup", async () => {
    let calls = 0
    let release: (() => void) | undefined
    const cached = createCachedHostGenerationClient(async () => {
      calls += 1
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return current(1)
    })

    const first = cached({ enrollmentId: "enr_1", generation: 1 })
    const second = cached({ enrollmentId: "enr_1", generation: 1 })
    await new Promise((resolve) => setTimeout(resolve, 1))
    release?.()
    await expect(Promise.all([first, second])).resolves.toEqual([current(1), current(1)])
    expect(calls).toBe(1)
  })
})

describe("checkHostTunnelGeneration", () => {
  function current(generation: number, revoked = false): HostGenerationResult {
    return { enrollmentId: "enr_1", generation, revoked }
  }

  test("admits without a resolver, and without a generation claim, and never asks the resolver for the latter", async () => {
    let calls = 0
    const lookup = async () => {
      calls += 1
      return current(9)
    }
    await expect(checkHostTunnelGeneration(undefined, { enrollment_id: "enr_1", generation: 1 })).resolves.toEqual({ ok: true })
    await expect(checkHostTunnelGeneration(lookup, {})).resolves.toEqual({ ok: true })
    await expect(checkHostTunnelGeneration(lookup, { enrollment_id: "enr_1" })).resolves.toEqual({ ok: true })
    expect(calls).toBe(0)
  })

  test("grades every conclusive answer as non-retryable", async () => {
    await expect(checkHostTunnelGeneration(async () => current(2), { enrollment_id: "enr_1", generation: 2 }))
      .resolves.toEqual({ ok: true })
    await expect(checkHostTunnelGeneration(async () => current(3), { enrollment_id: "enr_1", generation: 2 }))
      .resolves.toMatchObject({ ok: false, retryable: false, code: "host_generation_superseded" })
    await expect(checkHostTunnelGeneration(async () => current(1), { enrollment_id: "enr_1", generation: 2 }))
      .resolves.toMatchObject({ ok: false, retryable: false, code: "host_generation_unknown" })
    await expect(checkHostTunnelGeneration(async () => current(2, true), { enrollment_id: "enr_1", generation: 2 }))
      .resolves.toMatchObject({ ok: false, retryable: false, code: "host_enrollment_revoked" })
    await expect(checkHostTunnelGeneration(async () => undefined, { enrollment_id: "enr_1", generation: 2 }))
      .resolves.toMatchObject({ ok: false, retryable: false, code: "host_enrollment_unknown" })
  })

  test("grades a thrown lookup as retryable", async () => {
    await expect(checkHostTunnelGeneration(async () => {
      throw new Error("resolver down")
    }, { enrollment_id: "enr_1", generation: 2 })).resolves.toMatchObject({
      ok: false,
      retryable: true,
      code: "host_generation_lookup_unavailable",
      reason: "Host generation lookup is unavailable: resolver down",
    })
  })
})

describe("runtimeAccessTokenCacheTtlMsFromEnv", () => {
  test("uses the bounded default and accepts positive overrides", () => {
    expect(runtimeAccessTokenCacheTtlMsFromEnv({})).toBe(10_000)
    expect(runtimeAccessTokenCacheTtlMsFromEnv({
      CLAXEDO_RELAY_RUNTIME_ACCESS_TOKEN_CACHE_TTL_MS: "2500",
    })).toBe(2_500)
    expect(runtimeAccessTokenCacheTtlMsFromEnv({
      CLAXEDO_RELAY_RUNTIME_ACCESS_TOKEN_CACHE_TTL_MS: "0",
    })).toBe(10_000)
  })
})

describe("directHttpConcurrencyFromEnv", () => {
  test("accepts positive integer overrides and disables otherwise", () => {
    expect(directHttpConcurrencyFromEnv({})).toBeUndefined()
    expect(directHttpConcurrencyFromEnv({
      CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY: "64",
    })).toBe(64)
    expect(directHttpConcurrencyFromEnv({
      CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY: "0",
    })).toBeUndefined()
    expect(directHttpConcurrencyFromEnv({
      CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY: "not-a-number",
    })).toBeUndefined()
  })
})

describe("validateProductionEnv", () => {
  test("fails closed when CLAXEDO_RELAY_RESOLVER_TOKEN is missing in production", () => {
    const result = validateProductionEnv({
      NODE_ENV: "production",
      CLAXEDO_RELAY_RESOLVER_TOKEN: undefined,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(2)
      expect(result.message).toMatch(/CLAXEDO_RELAY_RESOLVER_TOKEN/)
    }
  })

  test("fails closed when CLAXEDO_RELAY_RESOLVER_TOKEN is empty string in production", () => {
    const result = validateProductionEnv({
      NODE_ENV: "production",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(2)
    }
  })

  test("fails closed when CLAXEDO_RELAY_RESOLVER_TOKEN is whitespace-only in production", () => {
    const result = validateProductionEnv({
      NODE_ENV: "production",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "   ",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(2)
    }
  })

  test("succeeds when CLAXEDO_RELAY_RESOLVER_TOKEN is missing in development", () => {
    const result = validateProductionEnv({
      NODE_ENV: "development",
      CLAXEDO_RELAY_RESOLVER_TOKEN: undefined,
    })
    expect(result.ok).toBe(true)
  })

  test("succeeds when CLAXEDO_RELAY_RESOLVER_TOKEN is missing in test environment", () => {
    const result = validateProductionEnv({
      NODE_ENV: "test",
      CLAXEDO_RELAY_RESOLVER_TOKEN: undefined,
    })
    expect(result.ok).toBe(true)
  })

  test("succeeds when CLAXEDO_RELAY_RESOLVER_TOKEN is missing and NODE_ENV is unset", () => {
    const result = validateProductionEnv({
      NODE_ENV: undefined,
      CLAXEDO_RELAY_RESOLVER_TOKEN: undefined,
    })
    expect(result.ok).toBe(true)
  })

  test("succeeds when CLAXEDO_RELAY_RESOLVER_TOKEN is set in production", () => {
    const result = validateProductionEnv({
      NODE_ENV: "production",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "secret-token",
    })
    expect(result.ok).toBe(true)
  })

  test("succeeds when CLAXEDO_RELAY_RESOLVER_TOKEN is set in development", () => {
    const result = validateProductionEnv({
      NODE_ENV: "development",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "secret-token",
    })
    expect(result.ok).toBe(true)
  })
})

describe("loadRuntimeAccessKeyOrJwks", () => {
  test("returns a JWKS resolver when CLAXEDO_CONTROL_PLANE_JWKS_URL is set", async () => {
    const result = await loadRuntimeAccessKeyOrJwks({
      CLAXEDO_CONTROL_PLANE_JWKS_URL: "https://example.test/.well-known/jwks.json",
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: undefined,
    })
    expect(typeof result).toBe("function")
  })

  test("returns a CryptoKey when only the PEM env var is set", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const spki = await exportSPKI(pair.publicKey)
    const result = await loadRuntimeAccessKeyOrJwks({
      CLAXEDO_CONTROL_PLANE_JWKS_URL: undefined,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: spki,
    })
    expect(typeof result).not.toBe("function")
    // Imported SPKI yields either a CryptoKey or a Node KeyObject; both are objects.
    expect(typeof result).toBe("object")
  })

  test("supports PEM env var with escaped newlines", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const spki = await exportSPKI(pair.publicKey)
    const escaped = spki.replace(/\n/g, "\\n")
    const result = await loadRuntimeAccessKeyOrJwks({
      CLAXEDO_CONTROL_PLANE_JWKS_URL: undefined,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: escaped,
    })
    expect(typeof result).not.toBe("function")
    expect(typeof result).toBe("object")
  })

  test("JWKS URL takes precedence when both env vars are set", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const spki = await exportSPKI(pair.publicKey)
    const result = await loadRuntimeAccessKeyOrJwks({
      CLAXEDO_CONTROL_PLANE_JWKS_URL: "https://example.test/.well-known/jwks.json",
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: spki,
    })
    expect(typeof result).toBe("function")
  })

  test("rejects when neither env var is set", async () => {
    await expect(
      loadRuntimeAccessKeyOrJwks({
        CLAXEDO_CONTROL_PLANE_JWKS_URL: undefined,
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: undefined,
      }),
    ).rejects.toThrow(/CLAXEDO_CONTROL_PLANE_JWKS_URL|CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM/)
  })

  test("rejects when both env vars are empty/whitespace", async () => {
    await expect(
      loadRuntimeAccessKeyOrJwks({
        CLAXEDO_CONTROL_PLANE_JWKS_URL: "  ",
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: "",
      }),
    ).rejects.toThrow()
  })

  test("rejects when the JWKS URL is malformed", async () => {
    await expect(
      loadRuntimeAccessKeyOrJwks({
        CLAXEDO_CONTROL_PLANE_JWKS_URL: "not-a-valid-url",
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: undefined,
      }),
    ).rejects.toThrow()
  })
})

describe("loadRelayHostKeyMaterial", () => {
  test("loads the public key from CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM when set", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const privatePem = await exportPKCS8(pair.privateKey)
    const publicPem = await exportSPKI(pair.publicKey)

    const result = await loadRelayHostKeyMaterial({
      CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: privatePem,
      CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM: publicPem,
    })

    expect(result.privateKey).toBeDefined()
    expect(result.current).toBeDefined()
    expect(result.current.publicKey).toBeDefined()
    expect(typeof result.current.kid).toBe("string")
    expect(result.current.kid.length).toBe(16)
    expect(result.next).toBeUndefined()
  })

  test("derives the public key from the private key when public PEM is unset", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const privatePem = await exportPKCS8(pair.privateKey)

    const result = await loadRelayHostKeyMaterial({
      CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: privatePem,
    })

    expect(result.privateKey).toBeDefined()
    expect(result.current.publicKey).toBeDefined()
    expect(typeof result.current.kid).toBe("string")
    expect(result.current.kid.length).toBe(16)
  })

  test("generates an ephemeral key pair when no signing key is configured", async () => {
    const result = await loadRelayHostKeyMaterial({})
    expect(result.privateKey).toBeDefined()
    expect(result.current.publicKey).toBeDefined()
    expect(typeof result.current.kid).toBe("string")
    expect(result.current.kid.length).toBe(16)
  })

  test("kid derivation is consistent between same-key calls (sha256-of-x)", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const privatePem = await exportPKCS8(pair.privateKey)

    const a = await loadRelayHostKeyMaterial({
      CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: privatePem,
    })
    const b = await loadRelayHostKeyMaterial({
      CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: privatePem,
    })

    expect(a.current.kid).toBe(b.current.kid)
  })

  test("includes a next key when CLAXEDO_RELAY_HOST_NEXT_PUBLIC_KEY_PEM is set", async () => {
    const current = await generateKeyPair("EdDSA", { extractable: true })
    const next = await generateKeyPair("EdDSA", { extractable: true })
    const privatePem = await exportPKCS8(current.privateKey)
    const currentPublicPem = await exportSPKI(current.publicKey)
    const nextPublicPem = await exportSPKI(next.publicKey)

    const result = await loadRelayHostKeyMaterial({
      CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: privatePem,
      CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM: currentPublicPem,
      CLAXEDO_RELAY_HOST_NEXT_PUBLIC_KEY_PEM: nextPublicPem,
    })

    expect(result.next).toBeDefined()
    expect(result.next?.kid).toBeDefined()
    expect(result.next?.kid).not.toBe(result.current.kid)
  })

  test("supports CLAXEDO_RELAY_HOST_KID env override for current key", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const privatePem = await exportPKCS8(pair.privateKey)

    const result = await loadRelayHostKeyMaterial({
      CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: privatePem,
      CLAXEDO_RELAY_HOST_KID: "explicit-rht-kid",
    })

    expect(result.current.kid).toBe("explicit-rht-kid")
  })

  describe("production fail-closed for ephemeral RHT signing key", () => {
    // Use the same exit-mock pattern as elsewhere: stub process.exit to throw,
    // so we can assert the loader bails before generating an ephemeral key.
    type ExitError = Error & { exitCode?: number }
    function withExitMock<T>(fn: () => Promise<T>): Promise<{ exitCode?: number; threw: boolean; result?: T }> {
      // Bound on capture: `process.exit` is a method that reads `this`, and a
      // bare reference held across the swap below would lose its receiver if
      // anything ever called it detached. Restoring the bound copy is
      // equivalent for every caller — they all go through `process.exit(...)`.
      const original = process.exit.bind(process)
      const originalConsoleError = console.error
      const errors: string[] = []
      process.exit = ((code?: number) => {
        const err = new Error(`process.exit(${code})`) as ExitError
        err.exitCode = code
        throw err
      }) as typeof process.exit
      console.error = (...args: unknown[]) => {
        errors.push(args.map((a) => String(a)).join(" "))
      }
      return (async () => {
        try {
          const result = await fn()
          return { threw: false, result }
        } catch (err) {
          const e = err as ExitError
          return { threw: true, exitCode: e.exitCode }
        } finally {
          process.exit = original
          console.error = originalConsoleError
          // Surface captured errors in case a test wants to inspect via the same channel later.
          void errors
        }
      })()
    }

    test("production + missing signing key calls process.exit(2)", async () => {
      const outcome = await withExitMock(() =>
        loadRelayHostKeyMaterial({
          NODE_ENV: "production",
          CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: undefined,
        }),
      )
      expect(outcome.threw).toBe(true)
      expect(outcome.exitCode).toBe(2)
    })

    test("production + empty signing key calls process.exit(2)", async () => {
      const outcome = await withExitMock(() =>
        loadRelayHostKeyMaterial({
          NODE_ENV: "production",
          CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: "",
        }),
      )
      expect(outcome.threw).toBe(true)
      expect(outcome.exitCode).toBe(2)
    })

    test("production + whitespace-only signing key calls process.exit(2)", async () => {
      const outcome = await withExitMock(() =>
        loadRelayHostKeyMaterial({
          NODE_ENV: "production",
          CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: "   ",
        }),
      )
      expect(outcome.threw).toBe(true)
      expect(outcome.exitCode).toBe(2)
    })

    test("development + missing signing key generates ephemeral key (existing behavior preserved)", async () => {
      const outcome = await withExitMock(() =>
        loadRelayHostKeyMaterial({
          NODE_ENV: "development",
          CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: undefined,
        }),
      )
      expect(outcome.threw).toBe(false)
      expect(outcome.result?.privateKey).toBeDefined()
      expect(outcome.result?.current.publicKey).toBeDefined()
      expect(outcome.result?.current.kid.length).toBe(16)
    })

    test("test environment + missing signing key generates ephemeral key", async () => {
      const outcome = await withExitMock(() =>
        loadRelayHostKeyMaterial({
          NODE_ENV: "test",
          CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: undefined,
        }),
      )
      expect(outcome.threw).toBe(false)
      expect(outcome.result?.privateKey).toBeDefined()
    })

    test("missing NODE_ENV defaults to dev behavior (still generates ephemeral)", async () => {
      const outcome = await withExitMock(() =>
        loadRelayHostKeyMaterial({
          NODE_ENV: undefined,
          CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: undefined,
        }),
      )
      expect(outcome.threw).toBe(false)
      expect(outcome.result?.privateKey).toBeDefined()
    })

    test("production + present signing key loads normally without exit", async () => {
      const pair = await generateKeyPair("EdDSA", { extractable: true })
      const privatePem = await exportPKCS8(pair.privateKey)

      const outcome = await withExitMock(() =>
        loadRelayHostKeyMaterial({
          NODE_ENV: "production",
          CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: privatePem,
        }),
      )
      expect(outcome.threw).toBe(false)
      expect(outcome.result?.privateKey).toBeDefined()
      expect(outcome.result?.current.publicKey).toBeDefined()
      expect(outcome.result?.current.kid.length).toBe(16)
    })
  })
})

describe("installShutdownDrainHandler (T9)", () => {
  test("setDraining is called when triggered", async () => {
    let drainingFlipped = false
    let waitCalled = false
    let disposed = false
    let exited = false
    const handle = installShutdownDrainHandler({
      drain: {
        isDraining: () => drainingFlipped,
        setDraining: (v: boolean) => {
          drainingFlipped = v
        },
        pendingCount: () => 0,
        waitForDrain: async () => {
          waitCalled = true
          return { drained: true, remaining: 0 }
        },
      },
      directory: {
        dispose: () => {
          disposed = true
        },
      },
      drainTimeoutMs: 100,
      exit: () => {
        exited = true
      },
      register: false,
    })

    await handle.trigger()

    expect(drainingFlipped).toBe(true)
    expect(waitCalled).toBe(true)
    expect(disposed).toBe(true)
    expect(exited).toBe(true)
  })

  test("calls directory.dispose() exactly once even if triggered twice", async () => {
    let disposeCount = 0
    let exitCount = 0
    const handle = installShutdownDrainHandler({
      drain: {
        isDraining: () => false,
        setDraining: () => {},
        pendingCount: () => 0,
        waitForDrain: async () => ({ drained: true, remaining: 0 }),
      },
      directory: {
        dispose: () => {
          disposeCount++
        },
      },
      drainTimeoutMs: 50,
      exit: () => {
        exitCount++
      },
      register: false,
    })

    await handle.trigger()
    await handle.trigger()

    expect(disposeCount).toBe(1)
    expect(exitCount).toBe(1)
  })

  test("disposes a real directory's sweep timer", async () => {
    const directory = createWorkspaceRelayDirectory({ sweepIntervalMs: 100 })
    let exited = false
    const handle = installShutdownDrainHandler({
      drain: {
        isDraining: () => false,
        setDraining: () => {},
        pendingCount: () => 0,
        waitForDrain: async () => ({ drained: true, remaining: 0 }),
      },
      directory,
      drainTimeoutMs: 10,
      exit: () => {
        exited = true
      },
      register: false,
    })

    await handle.trigger()
    expect(exited).toBe(true)
    // After dispose, the directory should still respond to method calls without
    // re-arming the timer. Calling dispose() again should be a no-op.
    directory.dispose()
  })

  // `stopServer` awaits `server.stop(true)`, which resolves only once every
  // socket is actually closed. A socket that never finishes closing must not
  // hold the drain open: the platform SIGKILLs us and we lose `dispose()` and
  // the exit code, which is strictly worse than force-exiting ourselves.
  test("exits even when stopServer never resolves", async () => {
    let disposed = false
    let exitCode: number | undefined
    const logs: string[] = []
    const handle = installShutdownDrainHandler({
      drain: {
        isDraining: () => false,
        setDraining: () => {},
        pendingCount: () => 0,
        waitForDrain: async () => ({ drained: true, remaining: 0 }),
      },
      directory: {
        dispose: () => {
          disposed = true
        },
      },
      drainTimeoutMs: 10,
      stopServer: () => new Promise<void>(() => {}),
      stopTimeoutMs: 20,
      exit: (code) => {
        exitCode = code
      },
      log: (message) => logs.push(message),
      register: false,
    })

    await handle.trigger()

    expect(disposed).toBe(true)
    expect(exitCode).toBe(0)
    expect(logs.some((line) => line.includes("stopServer did not finish within 20ms"))).toBe(true)
  })

  test("logs a stopServer rejection that lands after the bound expired", async () => {
    const logs: string[] = []
    let exited = false
    const handle = installShutdownDrainHandler({
      drain: {
        isDraining: () => false,
        setDraining: () => {},
        pendingCount: () => 0,
        waitForDrain: async () => ({ drained: true, remaining: 0 }),
      },
      directory: { dispose: () => {} },
      drainTimeoutMs: 10,
      // Rejects well after the bound: the handler has already moved on, so this
      // must be logged rather than surface as an unhandled rejection (which,
      // in the fatal path, would be a second crash on top of the first).
      stopServer: () =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("socket close wedged")), 40)
        }),
      stopTimeoutMs: 10,
      exit: () => {
        exited = true
      },
      log: (message) => logs.push(message),
      register: false,
    })

    await handle.trigger()
    expect(exited).toBe(true)

    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    expect(logs.some((line) => line.includes("stopServer failed: socket close wedged"))).toBe(true)
  })

  test("still awaits a stopServer that finishes inside the bound", async () => {
    const order: string[] = []
    const handle = installShutdownDrainHandler({
      drain: {
        isDraining: () => false,
        setDraining: () => {},
        pendingCount: () => 0,
        waitForDrain: async () => ({ drained: true, remaining: 0 }),
      },
      directory: {
        dispose: () => order.push("dispose"),
      },
      drainTimeoutMs: 10,
      stopServer: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 15))
        order.push("stopped")
      },
      stopTimeoutMs: 500,
      exit: () => order.push("exit"),
      register: false,
    })

    await handle.trigger()

    expect(order).toEqual(["stopped", "dispose", "exit"])
  })
})

describe("installFatalProcessHandlers", () => {
  test("marks draining, stops the server, disposes directory, and exits non-zero", async () => {
    let drainingFlipped = false
    let stopped = false
    let disposed = false
    let exitCode: number | undefined
    const logs: string[] = []
    const handle = installFatalProcessHandlers({
      drain: {
        isDraining: () => drainingFlipped,
        setDraining: (value) => {
          drainingFlipped = value
        },
        pendingCount: () => 0,
        waitForDrain: async () => ({ drained: true, remaining: 0 }),
      },
      directory: {
        dispose: () => {
          disposed = true
        },
      },
      stopServer: () => {
        stopped = true
      },
      exit: (code) => {
        exitCode = code
      },
      log: (message) => {
        logs.push(message)
      },
      register: false,
    })

    await handle.trigger(new Error("boom"), "uncaughtException")

    expect(handle.isFatal()).toBe(true)
    expect(drainingFlipped).toBe(true)
    expect(stopped).toBe(true)
    expect(disposed).toBe(true)
    expect(exitCode).toBe(1)
    expect(logs.some((line) => line.includes("fatal uncaughtException"))).toBe(true)
  })
  // The fatal path has the same bound as the drain path, and needs it more: we
  // are already unwinding a broken process, so a teardown step that never
  // settles would strand it with no exit code at all.
  test("exits non-zero even when stopServer never resolves", async () => {
    let disposed = false
    let exitCode: number | undefined
    const logs: string[] = []
    const handle = installFatalProcessHandlers({
      drain: {
        isDraining: () => false,
        setDraining: () => {},
        pendingCount: () => 0,
        waitForDrain: async () => ({ drained: true, remaining: 0 }),
      },
      directory: {
        dispose: () => {
          disposed = true
        },
      },
      stopServer: () => new Promise<void>(() => {}),
      stopTimeoutMs: 20,
      exit: (code) => {
        exitCode = code
      },
      log: (message) => logs.push(message),
      register: false,
    })

    await handle.trigger(new Error("boom"), "uncaughtException")

    expect(disposed).toBe(true)
    expect(exitCode).toBe(1)
    expect(logs.some((line) => line.includes("fatal stopServer did not finish within 20ms"))).toBe(true)
  })
})

describe("parseAuditAcceptSampleRate (T16)", () => {
  test("parses CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE=0.5 correctly", () => {
    expect(parseAuditAcceptSampleRate({
      CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE: "0.5",
      NODE_ENV: "production",
    })).toBe(0.5)
  })

  test("parses 0.0 as zero", () => {
    expect(parseAuditAcceptSampleRate({
      CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE: "0",
      NODE_ENV: "production",
    })).toBe(0)
  })

  test("parses 1.0 as one", () => {
    expect(parseAuditAcceptSampleRate({
      CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE: "1",
      NODE_ENV: "production",
    })).toBe(1)
  })

  test("falls back to default for negative values", () => {
    expect(parseAuditAcceptSampleRate({
      CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE: "-0.5",
      NODE_ENV: "production",
    })).toBe(0.1)
  })

  test("falls back to default for >1.0", () => {
    expect(parseAuditAcceptSampleRate({
      CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE: "2",
      NODE_ENV: "production",
    })).toBe(0.1)
  })

  test("falls back to default for NaN/non-numeric", () => {
    expect(parseAuditAcceptSampleRate({
      CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE: "not-a-number",
      NODE_ENV: "production",
    })).toBe(0.1)
  })

  test("default in production is 0.1", () => {
    expect(parseAuditAcceptSampleRate({
      NODE_ENV: "production",
    })).toBe(0.1)
  })

  test("default in development is 1.0", () => {
    expect(parseAuditAcceptSampleRate({
      NODE_ENV: "development",
    })).toBe(1)
  })

  test("default in test is 1.0", () => {
    expect(parseAuditAcceptSampleRate({
      NODE_ENV: "test",
    })).toBe(1)
  })

  test("default when NODE_ENV is unset is 1.0", () => {
    expect(parseAuditAcceptSampleRate({})).toBe(1)
  })

  test("empty string env var falls back to default", () => {
    expect(parseAuditAcceptSampleRate({
      CLAXEDO_RELAY_AUDIT_ACCEPT_SAMPLE_RATE: "",
      NODE_ENV: "production",
    })).toBe(0.1)
  })
})

describe("parseMetricsToken (T31)", () => {
  test("returns the trimmed value when CLAXEDO_RELAY_METRICS_TOKEN is set", () => {
    expect(parseMetricsToken({ CLAXEDO_RELAY_METRICS_TOKEN: "secret-123" })).toBe("secret-123")
  })

  test("trims surrounding whitespace", () => {
    expect(parseMetricsToken({ CLAXEDO_RELAY_METRICS_TOKEN: "  secret  " })).toBe("secret")
  })

  test("returns undefined when env var is missing", () => {
    expect(parseMetricsToken({})).toBeUndefined()
  })

  test("returns undefined for empty/whitespace-only env var", () => {
    expect(parseMetricsToken({ CLAXEDO_RELAY_METRICS_TOKEN: "" })).toBeUndefined()
    expect(parseMetricsToken({ CLAXEDO_RELAY_METRICS_TOKEN: "   " })).toBeUndefined()
  })
})
