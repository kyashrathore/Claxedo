import { expect, type Page } from "@playwright/test"

/** A rejected reply must leave the original request available to its owner. */
export async function expectPermissionReplyIsolation(page: Page, input: {
  backendUrl: string
  directory: string
  sessionId: string
  harness: string
  mode: string
}) {
  const query = `?directory=${encodeURIComponent(input.directory)}`
  const pending = await page.request.get(`${input.backendUrl}/permission${query}`)
  expect(pending.ok()).toBe(true)
  const rows = await pending.json() as Array<{ id: string; sessionID: string }>
  const owned = rows.filter((row) => row.sessionID === input.sessionId)
  expect(owned).toHaveLength(1)
  const sibling = await page.request.post(`${input.backendUrl}/session${query}&nativeHarness=${input.harness}`, {
    data: { harness: { id: input.harness, access: "native" }, permissionMode: input.mode },
  })
  expect(sibling.ok(), await sibling.text()).toBe(true)
  const { id } = await sibling.json() as { id: string }
  expect(id).not.toBe(input.sessionId)
  const reply = await page.request.post(`${input.backendUrl}/session/${id}/permissions/${owned[0].id}${query}`, {
    data: { response: "always" },
  })
  expect(reply.status()).toBe(409)
  expect(await reply.json()).toMatchObject({ error: { code: "interaction_session_mismatch" } })
  const after = await page.request.get(`${input.backendUrl}/permission${query}`)
  expect(after.ok()).toBe(true)
  expect(await after.json()).toEqual(rows)
}
