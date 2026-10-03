import type { PaneDefinition, PluginApi } from "@claxedo/plugin-api"
import { isJson, paneKindEntry, type Json, type PaneKind, type PaneProps } from "@/shell"
import { boundedView } from "../boundary"
import { entryId, PluginEntryError, type BindingScope } from "./services"
import { workbenchBinding } from "./workbench"

type Panes = Pick<PluginApi, "panes" | "workbench">

function toJson(scope: BindingScope, value: unknown): Json {
  const text = JSON.stringify(value)
  if (text === undefined) throw new PluginEntryError(scope.manifest.id, "a pane's restore.serialize must return JSON")
  const json: unknown = JSON.parse(text)
  if (!isJson(json)) throw new PluginEntryError(scope.manifest.id, "a pane's restore.serialize must return JSON")
  return json
}

function paneKind<State>(scope: BindingScope, pane: PaneDefinition<State>): PaneKind<State> {
  const { workbench } = scope.services
  const kind: PaneKind<State> = {
    kind: entryId(scope.manifest.id, pane.kind),
    title: (state) => pane.title(state),
    view: boundedView(scope.manifest.name, (props: PaneProps<State>) =>
      pane.render({
        paneId: props.paneId,
        state: props.state,
        setState: (next) => workbench.replacePane(props.paneId, kind, next),
        close: () => workbench.closePane(props.paneId),
      }),
    ),
    encode: (state) => toJson(scope, pane.restore.serialize(state)),
    decode: (value) => pane.restore.parse(value),
  }
  return kind
}

export function paneBindings(scope: BindingScope): Panes {
  const openers = new Map<string, (state: unknown) => void>()
  return {
    panes: {
      register: <State>(pane: PaneDefinition<State>) => {
        const kind = paneKind(scope, pane)
        const dispose = scope.sink.add(scope.services.registries.paneKinds, paneKindEntry(kind))
        openers.set(pane.kind, (state) => {
          const parsed = pane.restore.parse(state)
          if (parsed === undefined) throw new PluginEntryError(scope.manifest.id, `pane kind ${pane.kind} refused the state it was opened with`)
          scope.services.workbench.openPane(kind, parsed)
        })
        return () => {
          openers.delete(pane.kind)
          dispose()
        }
      },
      open: (kind, state) => {
        const open = openers.get(kind)
        if (!open) throw new PluginEntryError(scope.manifest.id, `no pane kind ${kind} is registered`)
        open(state)
      },
    },
    workbench: workbenchBinding(scope),
  }
}
