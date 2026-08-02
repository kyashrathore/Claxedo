import { describe, expect, test } from "bun:test"
import { exportJWK, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
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
import { createCachedTargetClient, type RuntimeAccessTokenActiveResult, type WorkspaceRelayTarget } from "./server"

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
    const inner = async (args: Args): Promise<RuntimeAccessTokenActiveResult> => {
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
    })
    expect(resolverClientCacheOptionsFromEnv({
      CLAXEDO_RELAY_TARGET_CACHE_TTL_MS: "15000",
      CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS: "5000",
    })).toEqual({
      targetCacheTtlMs: 15_000,
      revocationCacheTtlMs: 5_000,
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
      const original = process.exit
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

// Reference exportJWK so the import is not stripped if unused above.
void exportJWK
