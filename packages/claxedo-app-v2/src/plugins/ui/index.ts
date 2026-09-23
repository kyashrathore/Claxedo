import type { PluginComponents, PluginUi } from "@claxedo/plugin-api"
import { Badge, Button, Icon, IconButton, Loader, Tooltip } from "./controls"
import { Select, Switch, Tabs, TextInput, Textarea } from "./fields"
import type { Notices } from "./notices"
import { Dialog, Menu } from "./overlays"

export const pluginComponents: PluginComponents = {
  Button,
  IconButton,
  Icon,
  TextInput,
  Textarea,
  Select,
  Switch,
  Tabs,
  Menu,
  Dialog,
  Badge,
  Tooltip,
  Loader,
}

export function createPluginUi(notices: Notices): PluginUi {
  return { toast: notices.toast, confirm: notices.confirm, components: pluginComponents }
}

export { createNotices } from "./notices"
export type { Notices } from "./notices"
