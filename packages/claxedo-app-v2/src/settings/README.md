# settings

Owns: the settings sections the shell's settings page shows. The shell owns the page itself (`/settings/:section`), its sidebar mode and each section's `h1`; this domain exports `settingsSections` and draws what goes under the heading.

## Sections

| Section | Group | Draws | Owner of the data |
| --- | --- | --- | --- |
| Accounts | account | each agent's accounts and this machine's logins, with the one in use | the server (`server.queries.accounts`) |
| Usage | account | quota windows and usage through Claxedo | `src/usage/` |
| Organization | account | the org and your role | `src/access/` |
| Connections | account | GitHub and MCP connections | the server |
| Appearance | app | language, color scheme and theme | the i18n provider (`useI18n`) and the kit (`useTheme`) |
| Keyboard shortcuts | app | every command's shortcut; record, clear with Backspace, reset all | the shell palette's overrides (`useCommands`) |

`settingsSections` includes the Usage and Organization sections from their own domains, so the shell registers one array.

## Keyboard shortcuts

Rows are the palette's registered commands (`commands.options()` filtered by `commands.has`, which drops the palette's "suggested" copies) plus the palette itself (`shell.palette`), grouped by each command's category. Recording suspends the palette's own keybindings (`commands.keybinds(false)`) until a key is pressed or Escape cancels; the recorded binding is stored with `commands.setKeybind`, so the shell stays the one home of overrides.

## Strings

`i18n.ts` imports one dictionary per language from `locales/`; English is complete and the other sixteen fall back to it.

## Flows

15 (settings: theme and keyboard shortcuts on every section; accounts to follow).
