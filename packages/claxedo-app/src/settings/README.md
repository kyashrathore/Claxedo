# settings

Owns: the settings sections the shell's settings page shows. The shell owns the page itself (`/settings/:section`), its sidebar mode and each section's `h1`; this domain exports `settingsSections` and draws what goes under the heading.

## Sections

| Section | Group | Draws | Owner of the data |
| --- | --- | --- | --- |
| Usage | account | quota windows and usage through Claxedo | `src/usage/` |
| Organization | account | the org and your role | `src/access/` |
| Connections | account | GitHub and MCP connections; Connect… and Reconnect open the connect `FormDrawer` (`DrawerConnectIntegration`), and Disconnect, like removing another agent, runs only once `requestConfirm` returns yes from its destructive button | the server |
| Machines | account | the computers the account can run sessions on, each under its own name with its state in words and when it was last seen, from the devices list (Online, Offline or Paused, and for the computer the app runs on whether other devices can reach it); a delayed skeleton while it loads and a failure with Retry; no "This computer" tag and no global remote-access block. A machine the account has enrolled has Details, which opens `MachineDetails` (`view/machine-details.tsx`) in a `Drawer`: the connection check, Pause or Resume, and Remove. With none, one line says so; "Connect a machine…" (the group's action, or the empty line's) opens the connect instructions in a `Drawer`: the desktop app for the computer you sit at, and, for another machine, a name field that fills in the copyable invite command, the connect command, and "I've run it", which reads the list once and says "Waiting for <name>…" until a machine the list did not hold when the drawer opened appears, then "<name> is connected". `useConnectMachine` (`connect-machine.tsx`, also used by the composer's where chip, Projects and onboarding) opens the drawer as a lazy view behind `WithTranslations`, so the drawer and this domain's dictionary are not in the boot | `server.queries.machines.list()` (this machine and every enrolled machine); `server.machines` re-reads it, probes a machine and pauses, resumes or removes one |
| Language | app | the display language | the i18n provider (`useI18n`) |
| Appearance | app | grouped: Colors (color scheme, theme, contrast), Fonts (UI, code), Transcript (reasoning summaries, shell and edit parts expanded, read live by the timeline), Workspace panel (files navigator side, Left until the user picks one), Terminal (font, screen reader); every v1 General row lives here or in Language (Owner 00:55: no General) | the kit (`useTheme`) and `preferences.tsx` (`appearance`): the UI and code fonts are written to `--font-family-sans`/`--font-family-mono` on `<html>` only while one is chosen, so a theme's own font tokens apply otherwise; contrast is Codex's only (no other theme reads it, so the rows show only under Codex): `CONTRAST_DEFAULTS` (light 80, dark 40) is the one default, written to `--claxedo-contrast-light`/`-dark` on `<html>` before the shell renders, and a stored level wins; the terminal takes the terminal font (else the code font) and screen reader mode when it opens |
| System notifications | app | per alert (agent finished, permission required, error) a system notification on or off. A switch reads on only while the browser's permission is granted (`createSystemNotificationPermission`): turning one on asks the browser while it is unasked, a denied browser leaves every switch off under a note saying where to allow them, and a browser without the API disables them | `preferences.tsx` (`alerts.notify`), read by `@/notifications` |
| Sound effects | app | per alert a sound (Alert 01) or None; highlighting or choosing one plays it | `preferences.tsx` (`alerts.sound`), read by `@/notifications` |
| Keyboard shortcuts | app | every command's shortcut; record, clear with Backspace, reset all | the shell palette's overrides (`useCommands`) |

A connect that needs the provider's approval waits on `server.integrations.awaitGrant`, which reads the attempt again at the grant's interval (5 s unless the provider names one). A redirect grant (an MCP server's sign-in) settles on the deployment's callback page in the tab the sign-in opened, so the read also goes out the moment the person comes back to the app (the page turning visible or the window taking focus) instead of up to an interval later; a device grant (GitHub) waits out the provider's interval whatever happens, since polling sooner earns a `slow_down` that lengthens it.

`settingsSections` includes the Usage and Organization sections from their own domains. Settings → Models comes from `@/accounts` and is registered by the shell next to this array.

## Machine details

`createMachineCheck` (`machines.ts`) runs when the drawer opens and on Check again, never on a timer. It walks three hops in order and stops at the first that fails, so every hop after it reads "Not checked":

1. This device to Claxedo: `server.machines.recheck()` reads the devices list past the cache with no retry. A refusal is the hop's failure, shown by its error class's title.
2. Claxedo to the machine: the machine on that fresh list, found by its host id. Absent (removed elsewhere), Paused or Offline is the hop's failure; otherwise its last check-in is the detail.
3. The machine answering through the relay: `server.machines.probe()` reads `/global/health` of the first folder the devices list says the machine serves (`serving_workspace_ids`: assigned and acknowledged on its latest beat) through the transport, which mints the folder's connection and goes through the relay. A machine that serves no folder leaves this hop unchecked.

The `MachineCheck` machine is `reachingClaxedo` → `reachingRuntime` → `finished` with a `CheckVerdict` naming the failing hop; every event carries its attempt, so an answer from before a Check again changes nothing. The headline names the first failing hop, one line says what to try (`claxedo doctor` on the machine for an offline one), and Copy diagnostics copies the hops, the facts (state, last check-in, folders served, error class and code, when and which attempt) as text. The devices list carries no versions, so neither does the check.

Pause and Resume are one button that flips with the machine's state (`machines.pause` / `machines.resume`, the owner's `POST /api/claxedo/host/enrollments/pause` for that host id only); the line under it says what happened ("Paused: nothing reaches <name> until you resume it"), and the check runs again. Remove asks through `requestConfirm` (its sessions stay in history; new ones cannot start there until it is added again), then `machines.remove` revokes it, the drawer closes and a toast says it was removed. `ActionState` (`idle`, `working`, `done`, `failed`) owns the buttons' busy state and the line; a failure names the action and its error class's title.

## Keyboard shortcuts

Rows are the palette's registered commands (`commands.options()` filtered by `commands.has`, which drops the palette's "suggested" copies) plus the palette itself (`command.palette`, as today), grouped by each command's category. Recording suspends the palette's own keybindings (`commands.keybinds(false)`) until a key is pressed or Escape cancels; the recorded binding is stored with `commands.setKeybind`, so the shell stays the one home of overrides. The section draws its first 40 rows at once and 60 more each animation frame (`view/reveal.ts`) until every row is drawn, so opening it with hundreds of commands stays under one frame; rows are keyed by command id, so a rebound shortcut updates its own row's text and nothing else is rebuilt.

## Strings

`i18n.ts` imports one dictionary per language from `locales/`; English is complete and the other sixteen fall back to it.

## Flows

15 (settings: theme and keyboard shortcuts on every section; `15-settings-machines` covers Machines on the local stack and, on the signed web, the list's state and last seen, the details check with this device offline and with the machine's runtime stopped and their recovery, Pause, Resume, Remove with its confirmation, and Connect a machine waiting for a newly enrolled machine; its Models test belongs to `@/accounts`) and 43 (desktop: Machines lists the computer the desktop runs on, under the name Electron main reports).
