// Runner-neutral conformance cases for `CredentialStorePort`.
//
// The port has two secret readers on purpose: `resolveSecret` is the
// available-status-only token path, `readSecret` is the re-verify path that
// reads regardless of status. A host adapter that blurs those, or that echoes
// secret material through the metadata reader, breaks the kit's central
// promise that a stored secret is never observable outside the two secret
// seams. No case below asserts a secret's value; they assert shape, status
// gating, and — where the port must hide it — the secret's ABSENCE.
import type { CredentialRecord, CredentialStorePort } from "../types.js"

export const CREDENTIAL_STORE_CONFORMANCE_VERSION = 1 as const

export const CREDENTIAL_STORE_CONFORMANCE_SCOPE = {
  covered: [
    "put_then_get_reports_kind_and_available_status",
    "get_never_echoes_secret_material",
    "get_reports_expiry_only_when_supplied",
    "put_replaces_the_record_for_the_same_provider_id",
    "provider_ids_are_isolated_from_one_another",
    "resolve_secret_is_available_status_only",
    "read_secret_reads_regardless_of_status",
    "set_status_error_records_and_available_clears",
    "set_status_on_an_unknown_provider_is_a_no_op",
    "delete_by_provider_removes_metadata_and_both_secret_seams",
  ],
  // `readSecret` status side effects differ between hosts (the SQLite adapter
  // restores an errored credential to `available` on re-verify read). The port
  // documents the return value only, so only the return value is pinned.
  remaining: ["read_secret_status_side_effects", "webhook_signing_credential_lifecycle"],
} as const

export type CredentialStoreConformanceFactory = () => Promise<
  Readonly<{
    /** A store containing no credentials. */
    store: CredentialStorePort
  }>
>

export type CredentialStoreConformanceCase = Readonly<{
  name: string
  run: () => Promise<void>
}>

const PROVIDER_A = "integration:conformance-connection-a"
const PROVIDER_B = "integration:conformance-connection-b"

// Fixture material only — never asserted as a value, never printed.
const SECRET_A = "conformance-fixture-secret-a"
const SECRET_B = "conformance-fixture-secret-b"

/**
 * Returns runner-neutral conformance cases for a `CredentialStorePort`
 * implementation. The factory yields an empty store per case; every
 * assertion touches the adapter only through the public port.
 */
export function credentialStoreConformance(
  factory: CredentialStoreConformanceFactory,
): readonly CredentialStoreConformanceCase[] {
  const seed = async () => {
    const { store } = await factory()
    assert((await store.get(PROVIDER_A)) === undefined, "Conformance factory must yield an empty credential store")
    await store.put({ providerId: PROVIDER_A, kind: "api_key", secret: SECRET_A })
    return store
  }

  return [
    testCase("put then get reports the kind and an available status", async () => {
      const store = await seed()
      const record = await store.get(PROVIDER_A)
      assertEqual(record?.kind, "api_key", "get did not report the stored credential kind")
      assertEqual(record?.status, "available", "a freshly stored credential was not available")
      assertEqual(await store.get("integration:conformance-unknown"), undefined, "get resolved an unknown provider id")
    }),

    testCase("get never echoes secret material", async () => {
      const store = await seed()
      const record = (await store.get(PROVIDER_A)) as CredentialRecord & Record<string, unknown>
      assert(record !== undefined, "get lost the stored credential")
      const serialized = JSON.stringify(record)
      assert(!serialized.includes(SECRET_A), "get echoed the stored secret through its metadata record")
      for (const key of ["secret", "secure_ref", "secureRef", "token", "accessToken", "value"]) {
        assert(!(key in record), `get exposed a secret-bearing key: ${key}`)
      }
    }),

    testCase("get reports expiry only when supplied", async () => {
      const store = await seed()
      assert(!("expiresAt" in ((await store.get(PROVIDER_A)) ?? {})), "get invented an expiry that was never supplied")
      await store.put({ providerId: PROVIDER_B, kind: "oauth_token", secret: SECRET_B, expiresAt: 1_710_000_000_000 })
      const record = await store.get(PROVIDER_B)
      assertEqual(record?.kind, "oauth_token", "get did not report the oauth credential kind")
      assertEqual(record?.expiresAt, 1_710_000_000_000, "get did not round-trip the supplied expiry")
    }),

    testCase("put replaces the record for the same provider id", async () => {
      const store = await seed()
      await store.put({ providerId: PROVIDER_A, kind: "oauth_token", secret: SECRET_B, expiresAt: 42 })
      const record = await store.get(PROVIDER_A)
      assertEqual(record?.kind, "oauth_token", "a replacing put did not change the credential kind")
      assertEqual(record?.expiresAt, 42, "a replacing put did not change the expiry")
      assertEqual(record?.status, "available", "a replacing put did not reset status to available")
      assertSecretPresent(await store.resolveSecret(PROVIDER_A), "resolveSecret lost the replacement secret")
    }),

    testCase("provider ids are isolated from one another", async () => {
      const store = await seed()
      await store.put({ providerId: PROVIDER_B, kind: "api_key", secret: SECRET_B })
      await store.setStatus(PROVIDER_B, "error", "conformance")
      assertEqual((await store.get(PROVIDER_A))?.status, "available", "setStatus on one provider disturbed another")
      const first = await store.resolveSecret(PROVIDER_A)
      const second = await store.readSecret(PROVIDER_B)
      assertSecretPresent(first, "resolveSecret lost the first provider secret")
      assertSecretPresent(second, "readSecret lost the second provider secret")
      assert(first !== second, "two provider ids resolved to the same secret material")
    }),

    testCase("resolveSecret is available-status-only", async () => {
      const store = await seed()
      assertSecretPresent(await store.resolveSecret(PROVIDER_A), "resolveSecret refused an available credential")
      await store.setStatus(PROVIDER_A, "error", "conformance failure")
      assertEqual(await store.resolveSecret(PROVIDER_A), null, "resolveSecret served a non-available credential")
      assertEqual(await store.resolveSecret("integration:conformance-unknown"), null, "resolveSecret served an unknown provider")
    }),

    testCase("readSecret reads regardless of status", async () => {
      const store = await seed()
      await store.setStatus(PROVIDER_A, "error", "conformance failure")
      assertSecretPresent(await store.readSecret(PROVIDER_A), "readSecret refused a non-available credential")
      assertEqual(await store.readSecret("integration:conformance-unknown"), null, "readSecret served an unknown provider")
    }),

    testCase("setStatus error records and available clears", async () => {
      const store = await seed()
      await store.setStatus(PROVIDER_A, "error", "conformance failure")
      assertEqual((await store.get(PROVIDER_A))?.status, "error", "setStatus did not record the error status")
      await store.setStatus(PROVIDER_A, "available")
      assertEqual((await store.get(PROVIDER_A))?.status, "available", "setStatus did not restore the available status")
      assertSecretPresent(await store.resolveSecret(PROVIDER_A), "a restored credential was still refused by resolveSecret")
    }),

    testCase("setStatus on an unknown provider is a no-op", async () => {
      const store = await seed()
      await store.setStatus("integration:conformance-unknown", "error", "conformance")
      assertEqual(
        await store.get("integration:conformance-unknown"),
        undefined,
        "setStatus materialised a credential for an unknown provider",
      )
      assertEqual((await store.get(PROVIDER_A))?.status, "available", "setStatus on an unknown provider disturbed a stored one")
    }),

    testCase("deleteByProvider removes metadata and both secret seams", async () => {
      const store = await seed()
      await store.put({ providerId: PROVIDER_B, kind: "api_key", secret: SECRET_B })
      await store.deleteByProvider(PROVIDER_A)
      assertEqual(await store.get(PROVIDER_A), undefined, "deleteByProvider left the metadata record readable")
      assertEqual(await store.resolveSecret(PROVIDER_A), null, "deleteByProvider left the token seam readable")
      assertEqual(await store.readSecret(PROVIDER_A), null, "deleteByProvider left the re-verify seam readable")
      assertEqual((await store.get(PROVIDER_B))?.kind, "api_key", "deleteByProvider removed an unrelated provider")
      await store.deleteByProvider("integration:conformance-unknown")
      assertEqual((await store.get(PROVIDER_B))?.kind, "api_key", "deleting an unknown provider disturbed a stored one")
    }),
  ]
}

function testCase(name: string, run: () => Promise<void>): CredentialStoreConformanceCase {
  return { name, run }
}

/**
 * Asserts a secret seam produced material without ever comparing, echoing, or
 * embedding the value in an assertion message.
 */
function assertSecretPresent(value: string | null, message: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(message)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}\nExpected: ${String(expected)}\nActual: ${String(actual)}`)
}
