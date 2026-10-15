/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { WorkspaceRuntime } from "@/server"
import { composerEnglishDictionaries } from "../i18n"
import type { ComposerText } from "../text"
import { modelsEmptyNotice, type ModelsEmptyFacts } from "./models-empty-notice"

const t = ((key: string, params?: Record<string, unknown>) => [key, ...Object.values(params ?? {})].join(" ")) as ComposerText

function facts(runtime: WorkspaceRuntime, wakes: string[] = []): ModelsEmptyFacts {
  return { harnessName: "Claude Code", workspaceName: "Claxedo", runtime, wakeProgress: undefined, account: "present", unavailableHere: undefined, wake: () => void wakes.push("wake"), openProviders: () => undefined }
}

test("models empty: an asleep workspace offers Wake now in the picker, and never claims a message wakes it", () => {
  const wakes: string[] = []
  const notice = modelsEmptyNotice(t, facts({ kind: "asleep" }, wakes))
  expect(notice).toMatchObject({ message: "composer.models.asleep Claxedo", detail: "composer.models.asleep.detail", action: { label: "composer.models.wakeNow" } })
  notice?.action?.run()
  expect(wakes).toEqual(["wake"])
  const english = composerEnglishDictionaries.en
  expect(english["composer.models.asleep.detail"]).toBe("Its models load once it wakes.")
  expect(english["composer.models.wakeNow"]).toBe("Wake now")
})

test("models empty: a waking workspace shows the start's progress in place, and its models load when it is running", () => {
  expect(modelsEmptyNotice(t, { ...facts({ kind: "waking" }), wakeProgress: "Installing Claude Code · 0:12" })).toEqual({ message: "composer.models.waking Claxedo", detail: "Installing Claude Code · 0:12" })
  expect(modelsEmptyNotice(t, facts({ kind: "waking" }))).toEqual({ message: "composer.models.waking Claxedo", detail: "composer.models.waking.detail" })
})

test("models empty: a start that failed or hit the provider's limit shows the start's reason with Try again", () => {
  const wakes: string[] = []
  const error = { class: "rate_limit" as const, message: "Boat's start limit for this account is used up (200 starts per day)", retryable: false }
  const notice = modelsEmptyNotice(t, facts({ kind: "wakeFailed", error, retryAt: 1_000 }, wakes))
  expect(notice).toMatchObject({ message: "composer.models.wakeFailed Claxedo", detail: error.message, action: { label: "composer.models.retryWake" } })
  notice?.action?.run()
  expect(wakes).toEqual(["wake"])
})

test("models empty: a running workspace speaks of the harness's accounts, not the machine", () => {
  expect(modelsEmptyNotice(t, facts({ kind: "live" }))).toEqual({ message: "composer.models.empty Claude Code" })
  expect(modelsEmptyNotice(t, { ...facts({ kind: "live" }), account: "missing" })?.message).toBe("composer.models.none")
})
