import { createContext, type Accessor, type JSX } from "solid-js"

export type IconSkinIcons = Readonly<Record<string, () => JSX.Element>>

export const IconSkinContext = createContext<Accessor<IconSkinIcons | undefined>>()
