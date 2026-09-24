import { splitProps, type ComponentProps } from "solid-js"
import androidStudio from "./app-icon/android-studio.svg"
import antigravity from "./app-icon/antigravity.svg"
import cursor from "./app-icon/cursor.svg"
import fileExplorer from "./app-icon/file-explorer.svg"
import finder from "./app-icon/finder.png"
import ghostty from "./app-icon/ghostty.svg"
import iterm2 from "./app-icon/iterm2.svg"
import powershell from "./app-icon/powershell.svg"
import sublimeText from "./app-icon/sublimetext.svg"
import terminal from "./app-icon/terminal.png"
import textmate from "./app-icon/textmate.png"
import vscode from "./app-icon/vscode.svg"
import warp from "./app-icon/warp.png"
import xcode from "./app-icon/xcode.png"
import zedDark from "./app-icon/zed-dark.svg"
import zed from "./app-icon/zed.svg"
import { useTheme } from "@opencode-ai/ui/theme"
import "./app-icon.css"

const icons = {
  vscode,
  cursor,
  zed,
  "file-explorer": fileExplorer,
  finder,
  terminal,
  iterm2,
  ghostty,
  warp,
  xcode,
  "android-studio": androidStudio,
  antigravity,
  textmate,
  powershell,
  "sublime-text": sublimeText,
}

const darkIcons: Partial<Record<AppIconName, string>> = { zed: zedDark }

export type AppIconName = keyof typeof icons

export const appIconNames = Object.freeze(Object.keys(icons) as AppIconName[])

export type AppIconProps = Omit<ComponentProps<"img">, "src"> & {
  id: AppIconName
}

export function AppIcon(props: AppIconProps) {
  const [local, rest] = splitProps(props, ["id", "class", "classList", "alt", "draggable"])
  const theme = useTheme()
  const source = () => (theme.mode() === "dark" ? (darkIcons[local.id] ?? icons[local.id]) : icons[local.id])
  return (
    <img
      data-component="v2-app-icon"
      {...rest}
      src={source()}
      alt={local.alt ?? ""}
      draggable={local.draggable ?? false}
      classList={{
        "v2-app-icon": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    />
  )
}
