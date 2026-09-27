import { onCleanup, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { Button } from "@/ui"
import { daemonStatusBridge, followDaemonStatus, type DaemonStatus, type DaemonStatusBridge } from "../daemon-status"
import { shellDictionary } from "../i18n"

type Lost = Extract<DaemonStatus, { kind: "lost" }>

function LostBanner(props: { readonly bridge: DaemonStatusBridge }): JSX.Element {
  const t = useTranslator(shellDictionary)
  const daemon = followDaemonStatus(props.bridge)
  onCleanup(daemon.stop)
  const lost = (): Lost | undefined => {
    const status = daemon.status()
    return status.kind === "lost" ? status : undefined
  }
  const cause = (status: Lost) => {
    if (status.exit?.signal) return t("shell.daemonLost.signal", { signal: status.exit.signal })
    if (status.exit && status.exit.code !== null) return t("shell.daemonLost.code", { code: status.exit.code })
    return undefined
  }
  return (
    <Show when={lost()}>
      {(status) => (
        <div
          role="alert"
          data-testid="daemon-lost"
          class="fixed bottom-4 left-1/2 z-[10000] flex -translate-x-1/2 items-center gap-3 rounded-md border border-border-weak-base bg-background-base px-4 py-2 text-13-regular text-text-strong shadow-xl"
        >
          <span>
            {t("shell.daemonLost")}
            <Show when={cause(status())}>{(text) => <span class="text-text-weak"> ({text()})</span>}</Show>
          </span>
          <Button size="small" variant="contrast" disabled={daemon.restarting()} onClick={() => daemon.restart()}>
            {status().restart === "relaunch" ? t("shell.daemonLost.relaunch") : t("shell.daemonLost.reload")}
          </Button>
        </div>
      )}
    </Show>
  )
}

export function DaemonLostBanner(): JSX.Element {
  const bridge = daemonStatusBridge(globalThis)
  return <Show when={bridge}>{(present) => <LostBanner bridge={present()} />}</Show>
}
