/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import type { HostedAccount } from "./account"
import { ServerError } from "./errors"
import { folderQueries } from "./folders"
import { machineId } from "./ids"
import type { Transport } from "./transport"

const box = machineId("enr_box")

function machineAnswering(answer: (directory: unknown) => unknown) {
  const asked: unknown[] = []
  const account = {
    run: async (operation: string, input: Readonly<Record<string, unknown>>) => {
      asked.push([operation, input])
      return answer(input.directory)
    },
  } as unknown as HostedAccount
  const queries = folderQueries({ serverUrl: "http://127.0.0.1:4096" } as unknown as Transport, account)
  return { queries, asked, client: new QueryClient() }
}

test("a connected machine's checkout is present while its folder lists, and missing when the machine answers it is not a folder there", async () => {
  const { queries, asked, client } = machineAnswering((directory) => {
    if (directory === "/home/ada/gone") throw new ServerError({ class: "not_found", code: "folder_not_found", message: "/home/ada/gone is not a folder on this machine" })
    return { folders: [] }
  })
  expect(await client.fetchQuery(queries.presence("/home/ada/app", box))).toBe("present")
  expect(await client.fetchQuery(queries.presence("/home/ada/gone", box))).toBe("missing")
  expect(asked).toEqual([
    ["machines.folders", { enrollmentId: box, read: "children", directory: "/home/ada/app" }],
    ["machines.folders", { enrollmentId: box, read: "children", directory: "/home/ada/gone" }],
  ])
})

test("a machine that cannot be asked is a failure to read, never a missing checkout", async () => {
  const { queries, client } = machineAnswering(() => {
    throw new ServerError({ class: "conflict", code: "machine_offline", message: "build-box is offline" })
  })
  await expect(client.fetchQuery(queries.presence("/home/ada/app", box))).rejects.toMatchObject({ code: "machine_offline" })
})
