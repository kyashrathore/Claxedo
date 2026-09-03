import { describe, expect, test, vi } from "vitest"

import { CloudflareAccountOptionalServiceResources } from "./cloudflare-account-resources"

const databaseId = "11111111-1111-1111-1111-111111111111"

function json(result: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, result }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("Cloudflare optional-service resource owner", () => {
  test("creates Documents D1 and R2 and nothing else", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json([{ uuid: databaseId, name: "claxedo-documents-production" }]))
      .mockResolvedValueOnce(json(undefined, 404))
      .mockResolvedValueOnce(json({ name: "claxedo-documents-production" }))
    const resources = new CloudflareAccountOptionalServiceResources({
      accountId: "account-1",
      apiToken: "install-token",
      fetch,
      apiOrigin: "https://cloudflare.test/client/v4",
    })

    await expect(
      resources.provision({
        serviceId: "documents",
        workerName: "claxedo-documents-production",
        databaseName: "claxedo-documents-production",
        bucketName: "claxedo-documents-production",
      }),
    ).resolves.toEqual({ databaseId, bucketName: "claxedo-documents-production" })
    expect(fetch.mock.calls.map(([request, init]) => `${init?.method ?? "GET"} ${request}`)).toEqual([
      "GET https://cloudflare.test/client/v4/accounts/account-1/d1/database?name=claxedo-documents-production&per_page=100",
      "GET https://cloudflare.test/client/v4/accounts/account-1/r2/buckets/claxedo-documents-production",
      "PUT https://cloudflare.test/client/v4/accounts/account-1/r2/buckets/claxedo-documents-production",
    ])
  })

  test("refuses to retire a same-named replacement database", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      json([{ uuid: "22222222-2222-2222-2222-222222222222", name: "claxedo-documents-production" }]),
    )
    const resources = new CloudflareAccountOptionalServiceResources({
      accountId: "account-1",
      apiToken: "install-token",
      fetch,
      apiOrigin: "https://cloudflare.test/client/v4",
    })
    await expect(
      resources.retire({
        serviceId: "documents",
        workerName: "claxedo-documents-production",
        databaseName: "claxedo-documents-production",
        databaseId,
        retirementAuthorization: "archive:evidence-1",
      }),
    ).rejects.toMatchObject({ code: "resource_mismatch" })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
