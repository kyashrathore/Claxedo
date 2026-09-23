import { createContext, useContext, type ParentProps } from "solid-js"
import { createThemeStore, type ThemeStore } from "./store"

const ThemeContext = createContext<ThemeStore>()

export function ThemeProvider(props: ParentProps) {
  const store = createThemeStore()
  return <ThemeContext.Provider value={store}>{props.children}</ThemeContext.Provider>
}

export function useTheme(): ThemeStore {
  const store = useContext(ThemeContext)
  if (!store) throw new Error("useTheme needs a ThemeProvider above it")
  return store
}
