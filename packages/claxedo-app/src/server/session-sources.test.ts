/// <reference types="bun" />
import { expect, test } from "bun:test"
import { readSessionSources, type SessionSource } from "./session-sources"
import { compareListOrder, encodeListAfter, listOrderKey, type ListOrderKey } from "./wire/list-order"

type Item = { sessionId: string; sessionRef: string; createdAt: number; updatedAt: number; lastHumanTurnAt?: number }

function item(workspace: string, id: string, createdAt: number, lastHumanTurnAt?: number): Item {
  return {
    sessionId: id,
    sessionRef: `workspace:${workspace}:session:${id}`,
    createdAt,
    updatedAt: createdAt,
    ...(lastHumanTurnAt === undefined ? {} : { lastHumanTurnAt }),
  }
}

function decodeAfter(value: string): ListOrderKey {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"))
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as ListOrderKey
}

function store(items: Item[], limit: number, options: { required?: boolean; down?: () => boolean } = {}): SessionSource & { reads: (string | undefined)[] } {
  const reads: (string | undefined)[] = []
  return {
    reads,
    required: options.required ?? false,
    read: async (after) => {
      reads.push(after)
      if (options.down?.()) throw new Error("unreachable")
      const key = after ? decodeAfter(after) : undefined
      const ordered = items
        .filter((entry) => !key || compareListOrder(listOrderKey(entry)!, key) > 0)
        .sort((a, b) => compareListOrder(listOrderKey(a)!, listOrderKey(b)!))
      const page = ordered.slice(0, limit)
      return { items: page, ...(ordered.length > limit ? { nextAfter: encodeListAfter(listOrderKey(page.at(-1))!) } : {}) }
    },
  }
}

async function walk(sources: SessionSource[], limit: number, between?: (page: number) => void) {
  const pages: string[][] = []
  let after: string | undefined
  do {
    const page = await readSessionSources(sources, limit, after, { fill: true })
    pages.push(page.items.map((entry) => (entry as Item).sessionId))
    after = page.nextAfter
    between?.(pages.length)
  } while (after && pages.length < 20)
  return pages
}

test("session sources: the daemon's page and the account's page walk as one order under one key", async () => {
  const local = [item("ws_local", "l1", 10, 90), item("ws_local", "l2", 20), item("ws_local", "l3", 30), item("ws_local", "l4", 40)]
  const cloud = [item("ws_cloud", "c1", 15, 95), item("ws_cloud", "c2", 25), item("ws_cloud", "c3", 35)]
  const pages = await walk([store(local, 2, { required: true }), store(cloud, 2)], 2)

  expect(pages.length).toBeGreaterThanOrEqual(3)
  expect(pages.flat()).toEqual(["c1", "l1", "l4", "c3", "l3", "c2", "l2"])
})

test("session sources: sessions created between pages land in order, and nothing already shown repeats", async () => {
  const local = [item("ws_local", "l1", 10), item("ws_local", "l2", 20), item("ws_local", "l3", 30)]
  const cloud = [item("ws_cloud", "c1", 15), item("ws_cloud", "c2", 25)]
  const pages = await walk([store(local, 2, { required: true }), store(cloud, 2)], 2, (page) => {
    if (page === 1) local.push(item("ws_local", "behind", 1))
    if (page === 2) cloud.push(item("ws_cloud", "ahead", 999, 999))
  })
  const walked = pages.flat()

  expect(new Set(walked).size).toBe(walked.length)
  expect(walked).toContain("behind")
  expect(walked).not.toContain("ahead")
  for (const id of ["l1", "l2", "l3", "c1", "c2"]) expect(walked).toContain(id)
})

test("session sources: a failed account page leaves the daemon's rows with a degraded marker; a failed daemon page fails", async () => {
  let down = true
  const local = store([item("ws_local", "l1", 10)], 5, { required: true })
  const cloud = store([item("ws_cloud", "c1", 20)], 5, { down: () => down })

  expect(await readSessionSources([local, cloud], 5, undefined, { fill: true })).toEqual({ items: [item("ws_local", "l1", 10)], degraded: true })
  down = false
  expect((await readSessionSources([local, cloud], 5, undefined, { fill: true })).items.map((entry) => (entry as Item).sessionId)).toEqual(["c1", "l1"])
  await expect(readSessionSources([store([], 5, { required: true, down: () => true })], 5, undefined, { fill: true })).rejects.toThrow("unreachable")
})

test("session sources: a session two sources both answer is shown once, as the first source has it", async () => {
  const mine = { ...item("ws_local", "same", 10), title: "Local" }
  const published = { ...item("ws_local", "same", 10), title: "Published" }
  const page = await readSessionSources([store([mine], 5, { required: true }), store([published], 5)], 5, undefined, { fill: true })

  expect(page.items).toEqual([mine])
})

test("session sources: the key round-trips through its encoding", () => {
  const key = { updatedAt: 5, createdAt: 4, lastHumanTurnAt: 9, sessionRef: "workspace:ws_é:session:ses_1" }
  expect(decodeAfter(encodeListAfter(key))).toEqual(key)
})

test("a merge that does not fill answers one round: a source's filtered page shortens the page, and the next key resumes after the last row examined", async () => {
  const machine = store([item("ws_a", "a1", 30), item("ws_a", "a2", 20), item("ws_a", "a3", 10)], 2, { required: true })
  const filtered: SessionSource = { ...machine, read: async (after) => { const page = await machine.read(after); return { ...page, items: page.items.filter((entry) => (entry as Item).sessionId !== "a1") } } }
  const page = await readSessionSources([filtered], 2, undefined, { fill: false })
  expect(page.items.map((entry) => (entry as Item).sessionId)).toEqual(["a2"])
  expect(machine.reads).toEqual([undefined])
  expect(decodeAfter(page.nextAfter!).sessionRef).toBe("workspace:ws_a:session:a2")
})
