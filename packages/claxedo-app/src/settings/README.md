# settings

Owns: the settings sections the shell's settings page shows. The shell owns the page itself (`/settings/:section`), its sidebar mode and each section's `h1`; this domain exports `settingsSections` and draws what goes under the heading.

## Sections

| Section | Group | Draws | Owner of the data |
| --- | --- | --- | --- |
| Usage | account | quota windows and usage through Claxedo | `src/usage/` |
| Organization | account | the org and your role | `src/access/` |
| Connections | account | GitHub and MCP connections | the server |
| Machines | account | remote access (locked with today's reason until this build can publish a machine), the account's enrolled machines with their connection state, and the two steps to add one with copyable commands | `server.queries.machines.list` (`enrolled` machines only; an unenrolled local daemon has none, as today) |
| Language | app | the display language | the i18n provider (`useI18n`) |
| Appearance | app | grouped: Colors (color scheme, theme, contrast), Fonts (UI, code), Transcript (reasoning summaries, shell and edit parts expanded, read live by the timeline), Workspace panel (files navigator side, Left until the user picks one), Terminal (font, screen reader); every v1 General row lives here or in Language (Owner 00:55: no General) | the kit (`useTheme`) and `preferences.tsx` (`appearance`): the UI and code fonts are written to `--font-family-sans`/`--font-family-mono` on `<html>` only while one is chosen, so a theme's own font tokens apply otherwise; contrast is Codex's only (no other theme reads it, so the rows show only under Codex): `CONTRAST_DEFAULTS` (light 80, dark 40) is the one default, written to `--claxedo-contrast-light`/`-dark` on `<html>` before the shell renders, and a stored level wins; the terminal takes the terminal font (else the code font) and screen reader mode when it opens |
| System notifications | app | per alert (agent finished, permission required, error) a system notification on or off; turning one on asks the browser once | `preferences.tsx` (`alerts.notify`), read by `@/notifications` |
| Sound effects | app | per alert a sound (Alert 01) or None; highlighting or choosing one plays it | `preferences.tsx` (`alerts.sound`), read by `@/notifications` |
| Keyboard shortcuts | app | every command's shortcut; record, clear with Backspace, reset all | the shell palette's overrides (`useCommands`) |

`settingsSections` includes the Usage and Organization sections from their own domains. Settings → Models comes from `@/accounts` and is registered by the shell next to this array.

## Keyboard shortcuts

Rows are the palette's registered commands (`commands.options()` filtered by `commands.has`, which drops the palette's "suggested" copies) plus the palette itself (`command.palette`, as today), grouped by each command's category. Recording suspends the palette's own keybindings (`commands.keybinds(false)`) until a key is pressed or Escape cancels; the recorded binding is stored with `commands.setKeybind`, so the shell stays the one home of overrides. The section draws its first 40 rows at once and 60 more each animation frame (`view/reveal.ts`) until every row is drawn, so opening it with hundreds of commands stays under one frame; rows are keyed by command id, so a rebound shortcut updates its own row's text and nothing else is rebuilt.

## Strings

`i18n.ts` imports one dictionary per language from `locales/`; English is complete and the other sixteen fall back to it.

## Flows

15 (settings: theme and keyboard shortcuts on every section; its Models test belongs to `@/accounts`).
