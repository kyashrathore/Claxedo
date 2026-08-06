/**
 * One shared signal controls the UI and app icon consumers. The preference is
 * process-local; ThemeProvider remains the only persisted user setting.
 */
export {
  iconLibrary,
  iconLibraryPreference,
  setIconLibraryPreference,
  syncIconLibraryWithTheme,
  type IconLibraryPreference,
} from "@opencode-ai/ui/icon"
