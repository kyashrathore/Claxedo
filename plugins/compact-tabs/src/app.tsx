import { definePlugin } from "@claxedo/plugin-api"
import { Switcher } from "./switcher"

export { dictionary } from "./i18n"

export default definePlugin({
  activate(api) {
    api.overlays.register({ id: "switcher", keybinding: "mod+j", render: ({ close }) => <Switcher api={api} close={close} /> })
    api.commands.register({ id: "open", title: api.i18n.t("compactTabs.title"), run: () => api.overlays.open("switcher") })
  },
})
