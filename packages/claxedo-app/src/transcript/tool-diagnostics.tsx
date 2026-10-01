import { For, Show, type JSX } from "solid-js"
import { Icon } from "@/ui"
import { useTranscriptI18n } from "./i18n"

export interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

interface DiagnosticsResult {
  items: Diagnostic[]
  total: number
}

const DIAGNOSTICS_CAP = 3

export function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]> | undefined,
  filePath: string | undefined,
): DiagnosticsResult {
  if (!diagnosticsByFile || !filePath) return { items: [], total: 0 }
  const diagnostics = diagnosticsByFile[filePath] ?? []
  const errors = diagnostics.filter((d) => d.severity === 1)
  return { items: errors.slice(0, DIAGNOSTICS_CAP), total: errors.length }
}

export function DiagnosticsDisplay(props: { diagnostics: DiagnosticsResult }): JSX.Element {
  const i18n = useTranscriptI18n()
  const overflow = () => props.diagnostics.total - props.diagnostics.items.length
  return (
    <Show when={props.diagnostics.items.length > 0}>
      <div class="ui-diagnostics">
        <For each={props.diagnostics.items}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span class="ui-diagnostic-icon" aria-label={i18n.t("transcript.messagePart.diagnostic.error")}>
                <Icon name="circle-ban-sign" size="small" />
              </span>
              <span class="ui-diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span class="ui-diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
        <Show when={overflow() > 0}>
          <div class="ui-diagnostic-overflow">{i18n.t("transcript.messagePart.diagnostic.more", { count: overflow() })}</div>
        </Show>
      </div>
    </Show>
  )
}
