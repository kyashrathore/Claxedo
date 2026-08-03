import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import { createR2ConditionalObjectStore, type R2BucketBinding } from "./r2-object-store.cf"

describe("R2 conditional object store against Miniflare", () => {
  let miniflare: Miniflare
  let bucket: R2BucketBinding

  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      r2Buckets: ["DOCUMENTS"],
    })
    bucket = (await miniflare.getR2Bucket("DOCUMENTS")) as unknown as R2BucketBinding
  })

  afterAll(async () => {
    await miniflare.dispose()
  })

  test("honors create-only and ETag CAS while preserving bytes and prefix listings", async () => {
    const store = createR2ConditionalObjectStore(bucket)
    const initial = new TextEncoder().encode("# Initial\n")
    const created = await store.put("documents/org/project/document/plan.md", initial, { absent: true })

    expect(created?.etag).toBeTruthy()
    await expect(
      store.put("documents/org/project/document/plan.md", new TextEncoder().encode("lost"), { absent: true }),
    ).resolves.toBeUndefined()
    await expect(
      store.put("documents/org/project/document/plan.md", new TextEncoder().encode("lost"), { etag: "stale" }),
    ).resolves.toBeUndefined()

    const updated = await store.put(
      "documents/org/project/document/plan.md",
      new TextEncoder().encode("# Updated\n"),
      { etag: created!.etag },
    )
    expect(updated?.etag).toBeTruthy()
    expect(updated?.etag).not.toBe(created?.etag)
    expect(new TextDecoder().decode((await store.get("documents/org/project/document/plan.md"))?.body)).toBe(
      "# Updated\n",
    )
    expect((await store.list("documents/org/project/")).map((object) => object.key)).toEqual([
      "documents/org/project/document/plan.md",
    ])

    await store.delete("documents/org/project/document/plan.md")
    await expect(store.get("documents/org/project/document/plan.md")).resolves.toBeUndefined()
  })
})
