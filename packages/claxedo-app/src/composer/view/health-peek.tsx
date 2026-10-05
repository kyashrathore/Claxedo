import { createMemo } from "solid-js"
import type { ComposerSetup } from "../setup"
import { publishComposerNotice } from "./composer-notice"

export function SessionHealthPeek(props: { composer: ComposerSetup }) {
  const scope = () => props.composer.key()
  const readiness = createMemo(() => props.composer.harnessController.read(scope()).readiness)
  const degraded = createMemo(() => props.composer.working() && readiness() === "degraded")
  const probe = () => void props.composer.harnessController.probeHealth(scope(), props.composer.harnessScopeInput())
  publishComposerNotice(() =>
    degraded()
      ? { kind: "session-health", tone: "warning", message: props.composer.t("composer.health.stopped"), action: { label: props.composer.t("composer.health.checkAgain"), run: probe } }
      : undefined,
  )
  return null
}
