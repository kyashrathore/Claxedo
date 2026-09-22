import { parseDesktopTheme } from "./parse"
import oc2ThemeJson from "./themes/oc-2.json"

// The one theme the provider holds before any pick; every other theme loads
// through the `./themes/*.json` glob in context.tsx when it is chosen.
export const oc2Theme = parseDesktopTheme(oc2ThemeJson, "themes/oc-2.json")
