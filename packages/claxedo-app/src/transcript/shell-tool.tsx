import stripAnsi from "strip-ansi"
import { animate } from "motion"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { Icon, IconButton, TextShimmer, Tooltip } from "@/ui"
import { copyText } from "@/lib/clipboard"
import { BasicTool, shellExitCode, ToolExitCode } from "./basic-tool"
import { useTranscriptI18n } from "./i18n"
import { localPreviewUrl } from "./local-preview"
import type { ToolProps } from "./message-part"
import { ScrollableOutput } from "./scrollable-output"
import { shellDescription, stripShellWrapper } from "./shell-label"
import { handleTranscriptLinkClick } from "./transcript-link"

function ShellSubmessage(props: { text: string; animate?: boolean }) {
  let widthRef: HTMLSpanElement | undefined
  let valueRef: HTMLSpanElement | undefined

  onMount(() => {
    if (!props.animate) return
    requestAnimationFrame(() => {
      if (widthRef) {
        animate(widthRef, { width: "auto" }, { type: "spring", visualDuration: 0.25, bounce: 0 })
      }
      if (valueRef) {
        animate(valueRef, { opacity: 1, filter: "blur(0px)" }, { duration: 0.32, ease: [0.16, 1, 0.3, 1] })
      }
    })
  })

  return (
    <span data-component="shell-submessage">
      <span ref={widthRef} data-slot="shell-submessage-width" style={{ width: props.animate ? "0px" : undefined }}>
        <span data-slot="basic-tool-tool-subtitle">
          <span
            ref={valueRef}
            data-slot="shell-submessage-value"
            style={props.animate ? { opacity: 0, filter: "blur(2px)" } : undefined}
          >
            {props.text}
          </span>
        </span>
      </span>
    </span>
  )
}

export function ShellTool(props: ToolProps) {
  const i18n = useTranscriptI18n()
  const pending = () => props.status === "pending" || props.status === "running"
  const sawPending = pending()
  const displayCommand = createMemo(() =>
    stripShellWrapper(String(props.input.command ?? props.metadata.command ?? "")),
  )
  const description = createMemo(() => shellDescription(props.input))
  const text = createMemo(() => {
    const cmd = displayCommand()
    const out = stripAnsi(props.output || props.metadata.output || "").replace(/\r\n?/g, "\n")
    return `$ ${cmd}${out ? "\n\n" + out : ""}`
  })
  const [copied, setCopied] = createSignal(false)

  const localUrl = createMemo(() => {
    if (pending()) return undefined
    return localPreviewUrl(stripAnsi(props.output || props.metadata.output || ""))
  })
  const localLabel = () => localUrl()?.replace(/^https?:\/\//, "").replace(/\/$/, "")

  const handleCopy = async () => {
    const content = text()
    if (!content) return
    if ((await copyText(content)).copied) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <>
    <BasicTool
      {...props}
      icon="terminal"
      trigger={(open) => (
        <div data-slot="basic-tool-tool-info-structured">
          <div data-slot="basic-tool-tool-info-main">
            <Show
              when={description()}
              fallback={
                <>
                  <span data-slot="basic-tool-tool-title">
                    <TextShimmer text={pending() ? "Running" : "Ran"} active={pending()} />
                  </span>
                  <Show when={displayCommand()}>
                    <ShellSubmessage text={displayCommand()} animate={sawPending && !open()} />
                  </Show>
                </>
              }
            >
              {(text) => (
                <span data-slot="basic-tool-tool-subtitle">
                  <TextShimmer text={text()} active={pending()} />
                </span>
              )}
            </Show>
            <ToolExitCode code={pending() ? undefined : shellExitCode(props.metadata)} />
          </div>
        </div>
      )}
    >
      <div class="ui-bash-output">
        <div class="ui-bash-copy">
          <Tooltip value={copied() ? i18n.t("transcript.message.copied") : i18n.t("transcript.message.copy")} placement="top">
            <IconButton
              icon={<Icon name={copied() ? "check" : "copy"} size="small" />}
              size="normal"
              variant="ghost-muted"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleCopy}
              aria-label={copied() ? i18n.t("transcript.message.copied") : i18n.t("transcript.message.copy")}
            />
          </Tooltip>
        </div>
        <ScrollableOutput class="ui-bash-scroll" revealed={props.revealed} onRevealedChange={props.onRevealedChange}>
          <pre data-slot="bash-pre">
            <code>{text()}</code>
          </pre>
        </ScrollableOutput>
      </div>
    </BasicTool>
    <Show when={localUrl()}>
      <a
        data-component="local-preview-row"
        href={localUrl()}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleTranscriptLinkClick}
      >
        <span data-slot="local-preview-icon">
          <Icon name="window-cursor" size="small" />
        </span>
        <span class="ui-local-preview-verb">Local preview</span>
        <span class="ui-local-preview-url">{localLabel()}</span>
      </a>
    </Show>
    </>
  )
}
