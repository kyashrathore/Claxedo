import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { Dynamic, Portal } from "solid-js/web"
import { useCommands } from "../palette/commands"
import { useShellRegistries } from "../registries"
import { Region } from "./region"

export function Overlays(): JSX.Element {
  const registries = useShellRegistries()
  const commands = useCommands()
  const [openId, setOpenId] = createSignal<string>()
  const open = createMemo(() => registries.overlays.list().find((entry) => entry.id === openId()))
  const close = () => setOpenId(undefined)

  commands.register("shell.overlays", () =>
    registries.overlays.list().map((entry) => ({
      id: `overlay.${entry.id}`,
      title: entry.id,
      keybind: entry.keybinding,
      hidden: true,
      onSelect: () => setOpenId((current) => (current === entry.id ? undefined : entry.id)),
    })),
  )

  return (
    <Show when={open()}>
      {(entry) => (
        <Portal>
          <div class="shell-overlay" data-overlay={entry().id}>
            <Region name="overlay">
              <Dynamic component={entry().view} close={close} />
            </Region>
          </div>
        </Portal>
      )}
    </Show>
  )
}
