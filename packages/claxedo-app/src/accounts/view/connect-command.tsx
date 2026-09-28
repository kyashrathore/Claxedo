import { createSignal, onCleanup } from "solid-js"
import { copyText } from "@/lib/clipboard"
import { ClaxedoIconButton as IconButton } from "@/ui"
import { useAccountsText } from "../i18n"

const COPIED_MS = 1500

export function ConnectCommand(props: { readonly command: string }) {
  const t = useAccountsText()
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const copy = async () => {
    if (!(await copyText(props.command)).copied) return
    setCopied(true)
    clearTimeout(timer)
    timer = setTimeout(() => setCopied(false), COPIED_MS)
  }
  return (
    <div class="flex w-full flex-col gap-1.5">
      <span class="text-12-regular text-text-weak">{t("provider.connect.token.command")}</span>
      <div class="flex items-center gap-2 rounded-md bg-surface-base px-3 py-2">
        <code class="min-w-0 flex-1 truncate font-mono text-13-regular text-text-strong">{props.command}</code>
        <IconButton
          icon={copied() ? "check-small" : "copy"}
          variant="ghost"
          aria-label={t("provider.connect.token.copyCommand")}
          data-action="provider-connect-copy-command"
          onClick={() => void copy()}
        />
      </div>
    </div>
  )
}
