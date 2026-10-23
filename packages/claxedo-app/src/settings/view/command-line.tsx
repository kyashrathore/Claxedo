import { createSignal } from "solid-js"
import { copyText } from "@/lib/clipboard"
import { ClaxedoIconButton } from "@/ui"

export type CommandLayout = "line" | "snippet" | "wrapped"

export function CommandLine(props: { readonly command: string; readonly label: string; readonly layout?: CommandLayout }) {
  const [copied, setCopied] = createSignal(false)
  const copy = () => {
    void copyText(props.command).then((result) => setCopied(result.copied))
  }
  return (
    <div class="settings-command" classList={{ "settings-command-snippet": props.layout === "snippet", "settings-command-wrapped": props.layout === "wrapped" }}>
      <code>{props.command}</code>
      <ClaxedoIconButton icon={copied() ? "check" : "copy"} size="small" variant="ghost" aria-label={props.label} onClick={copy} />
    </div>
  )
}
