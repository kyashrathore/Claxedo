/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ServerError, type MintedInvitation, type ServerInvitation } from "@/server"
import { createServerCommand, isServerFolder, serverCommandTransition } from "./server-invitation"

const invitation: MintedInvitation = {
  id: "invitation_1",
  expiresAt: 3_600_000,
  commands: { posix: "curl … --invitation t --root '/srv/app'", windows: "& … -Invitation t -Root '/srv/app'", cloudInit: "#cloud-config\nruncmd:\n  - \"curl …\"" },
}

test("a minted answer lands only on the attempt that asked for it, and an edit drops a command that no longer matches the form", () => {
  const minting = serverCommandTransition({ kind: "editing", attempt: 0 }, { type: "mint" })
  expect(minting).toEqual({ kind: "minting", attempt: 1 })
  expect(serverCommandTransition(minting, { type: "mint" })).toBe(minting)
  const edited = serverCommandTransition(minting, { type: "edited" })
  expect(edited).toEqual({ kind: "editing", attempt: 2 })
  expect(serverCommandTransition(edited, { type: "minted", attempt: 1, invitation }), "an answer for the form as it was").toBe(edited)

  const minted = serverCommandTransition(minting, { type: "minted", attempt: 1, invitation })
  expect(minted).toEqual({ kind: "minted", attempt: 1, invitation })
  expect(serverCommandTransition(minted, { type: "edited" })).toEqual({ kind: "editing", attempt: 2 })
  const failed = serverCommandTransition(minting, { type: "failed", attempt: 1, error: new ServerError({ class: "network", message: "offline" }) })
  expect(failed.kind).toBe("failed")
  expect(serverCommandTransition(failed, { type: "mint" })).toEqual({ kind: "minting", attempt: 2 })
})

test("the folder is one the server writes in full, on a POSIX or a Windows server", () => {
  for (const folder of ["/srv/app", " /home/ubuntu/app ", "C:\\work\\app", "\\\\box\\share\\app"]) expect(isServerFolder(folder), folder).toBe(true)
  for (const folder of ["", "srv/app", "~/app", "C:app"]) expect(isServerFolder(folder), folder).toBe(false)
})

test("minting sends the name and folder trimmed, asks once while it waits, and a refusal becomes the failed state", async () => {
  const asked: ServerInvitation[] = []
  let answer: (value: MintedInvitation) => void = () => {}
  await createRoot(async (dispose) => {
    const command = createServerCommand({
      invite: (server) => {
        asked.push(server)
        return new Promise((resolve) => { answer = resolve })
      },
    })
    const first = command.mint({ name: " build-box ", folder: " /srv/app " })
    void command.mint({ name: "build-box", folder: "/srv/app" })
    expect(command.state().kind).toBe("minting")
    answer(invitation)
    await first
    expect(asked).toEqual([{ name: "build-box", folder: "/srv/app" }])
    expect(command.state()).toEqual({ kind: "minted", attempt: 1, invitation })

    const refusing = createServerCommand({ invite: async () => { throw new ServerError({ class: "invalid", message: "scope.allowed_roots must be absolute paths" }) } })
    await refusing.mint({ name: "", folder: "/srv/app" })
    const state = refusing.state()
    expect(state.kind === "failed" && state.error.class).toBe("invalid")
    dispose()
  })
})
