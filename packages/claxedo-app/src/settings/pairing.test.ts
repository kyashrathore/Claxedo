import { expect, test } from "bun:test"
import type { MintedPairing, Pairing } from "@/server"
import { codeExpired, codeTimeLeft, connectCodeTransition, guessedPlatform, stageLineValues } from "./pairing"

const minted: MintedPairing = { id: "pair_1", code: "K7QM4PXD9R2TWB6HJ3NF", expiresAt: 900_000, commands: { posix: "curl", windows: "irm" } }
const offline = { class: "network", retryable: true, message: "offline" } as const

test("a code answer counts only for the attempt that asked for it, and a remint starts the next attempt", () => {
  const first = connectCodeTransition({ kind: "minting", attempt: 1 }, { type: "minted", attempt: 1, minted })
  expect(first).toEqual({ kind: "minted", attempt: 1, minted })
  const second = connectCodeTransition(first, { type: "remint" })
  expect(second).toEqual({ kind: "minting", attempt: 2 })
  expect(connectCodeTransition(second, { type: "minted", attempt: 1, minted }), "a late answer for the old code").toEqual(second)
  expect(connectCodeTransition(second, { type: "failed", attempt: 2, error: offline })).toEqual({ kind: "failed", attempt: 2, error: offline })
})

test("a code runs out while no machine has asked with it, or when the control plane says it expired; a machine waiting for an answer keeps it", () => {
  const waiting: Pairing = { id: "pair_1", stage: "waiting", expiresAt: 900_000 }
  expect(codeExpired(minted, waiting, 899_999)).toBe(false)
  expect(codeExpired(minted, waiting, 900_000)).toBe(true)
  expect(codeExpired(minted, undefined, 900_000), "before the first read").toBe(true)
  const asking: Pairing = { ...waiting, stage: "awaitingApproval", request: "machine", expiresAt: 1_800_000 }
  expect(codeExpired(minted, asking, 1_000_000)).toBe(false)
  expect(codeExpired(minted, { ...asking, stage: "expired" }, 1_000_000)).toBe(true)
})

test("the countdown reads minutes and seconds and stops at zero", () => {
  expect(codeTimeLeft(900_000, 0)).toBe("15:00")
  expect(codeTimeLeft(900_000, 899_001)).toBe("0:01")
  expect(codeTimeLeft(900_000, 950_000)).toBe("0:00")
})

test("the command shown first is Windows only on a Windows browser", () => {
  expect(guessedPlatform("Win32")).toBe("windows")
  expect(guessedPlatform("MacIntel")).toBe("posix")
  expect(guessedPlatform("Linux x86_64")).toBe("posix")
  expect(guessedPlatform("")).toBe("posix")
})

test("a stage line names the machine by its given name, else the name it asked with, and the folder by its last part", () => {
  const machine = { hostname: "studio", os: "Ubuntu", arch: "x64", folder: "/home/ubuntu/code/app", folderKind: "folder" } as const
  expect(stageLineValues({ id: "p", stage: "ready", expiresAt: 0, machine, name: "studio-box" })).toEqual({ name: "studio-box", folder: "app" })
  expect(stageLineValues({ id: "p", stage: "awaitingApproval", expiresAt: 0, machine })).toEqual({ name: "studio", folder: "app" })
  expect(stageLineValues({ id: "p", stage: "installing", expiresAt: 0, installingOn: { hostname: "vm-1", os: "Linux" } })).toEqual({ name: "vm-1", folder: "" })
})
