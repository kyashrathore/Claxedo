# Accounts

Owns: the logins each agent harness runs on, and today's app's surfaces for them: Settings → Models (`modelsSettingsSection`, registered in the shell's settings sections) and the first run's AI step. Both render the same `AgentHarnessAccounts` for the CLI harnesses (Claude Code, Codex, Cursor) and the same `HarnessProvidersSection` for the catalog harnesses (Pi, OpenCode).

## Data

- `useAccounts()` (`store.ts`) reads three adapter queries: stored accounts (`server.queries.accounts.list`), the ones in use (`effective`) and this machine's CLI logins (`machineLogins`). Nothing reads them at app start: the machine-login read starts the harness CLIs, so it runs only when Settings → Models or the AI step mounts.
- Rescan asks every CLI again (`server.accounts.rescan`, `fresh=1`) and rereads the stored rows. Select, remove and check go through `server.accounts`; a failed write is a "Request failed" toast.
- A live check of a stored account is kept on the page (`liveChecks`) and outranks the verdict the server stored; a check that never reached the provider is kept as `unknown` with its reason.
- `model.ts` holds the harness list (Claude Code, Codex, Cursor) and the rules: which row is selected (the server's effective read first, then the stored mark, then this computer's login), whether a login is refused or unavailable, whether this computer's login would strand a binding, and whether a harness can run a turn (`harnessRunnable`).
- `account-words.ts` turns a row into what the row says: label, second line (verdict, plan windows), hint, alert and reach.

## Catalog harnesses

`createHarnessProviders(harness)` wraps the composer's `createProviderCatalog` over `server.harnessConfig.providers`: the providers the harness offers, the connected ones first, and each connected provider's detail loaded once so its source tag (Config, Environment, API key, Custom) can show. A catalog of more than 24 providers lists the connected and the popular ones until a search names others. Connect opens the same dialog in the engine's words ("Connect {vendor} for {engine}"); Disconnect, offered for API-key and custom providers, deletes the stored credential and the harness's auth entry (`server.providerConnect.disconnect`). OpenCode also takes a custom OpenAI-compatible provider (`DialogCustomProvider`, `server.providerConnect.saveCustomProvider`).

## Models tab

Each harness section on Settings → Models has an Accounts and a Models tab, the open one remembered per harness while the page is open, and a "{count} models" figure for the models switched on. The Models tab reads the harness's models for the settings placement (the first available project's folder placement): a catalog harness from its provider catalog (every provider's detail loaded once), any other from `server.queries.harnesses.options`. Models are grouped by provider (Pi by vendor); a harness that is its own only provider lists its models without a group row. Switches and Enable all / Disable all write the composer's model visibility (`useModelVisibility` from `@/composer`), which the composer's picker reads. With no project the page says "No workspaces yet" under the scan line. Enabled ACP connections get a section whose Accounts tab says they run on the connection they were set up with.

## Harness catalog (`@/lib/harness-catalog`)

- The ids, names and provider ids of Claude Code, Codex and Cursor are the runtime contract's `HARNESS_TABLE`: the server stores a login against those ids and the machine scan reports them, so a second list here would lose an account the moment the two disagreed. Pi and OpenCode are engines a reader picks, not logins anything is stored against, so they carry only a name and a brand mark.
- A key no catalog entry answers to (a historical session's harness, an operator's ACP connection id) is named by `harnessDisplayLabel`, the label of last resort; a server-supplied label wins wherever discovery data is at hand.
- A registry key (`claude-sdk`, `codex-app-server`) names the binding a login is stored against and nothing a reader would recognise, so it is shown as its harness's name (`harnessLabelForProviderId`).
- A harness's vendor id (`anthropic` under Claude Code) is that vendor's models routed through the harness, never something signing its CLI in answers for. A login's reach is compared against the harness's bindings only (`partialMachineLogin` in `model.ts`); against the full list every complete login would read as partial. A key the table has never heard of has no vendor row to subtract, so its whole list is its bindings.
- The connect card says one of two sentences (`ConnectContext`): `harness` is a login the harness itself runs on (one account, one harness); `engine` is a vendor's models made available inside an engine that runs several vendors, where the account is not the thing being run. Only the provider id a harness's own sign-in is stored against (`harnessForConnectProvider`) takes the harness sentence; every other provider id (`openai` under Codex) takes the engine one. Both halves of each sentence are read through `connectContextKey`, so a locale that carries one and not the other shows a missing string rather than quietly falling back to the other sentence.

## Connect

"Add an account" and "Reconnect" open `DialogProviderConnect`. `createProviderConnect` (`connect-form.ts`) lists the provider's methods from `server.queries.providerConnect.authMethods(harness)`, joined by type to the vendor copy in `connect-methods.ts` (with a pasted-key fallback when the server lists none), and then:

- a key or subscription token is saved as a managed credential with the user's label (`saveKey`), replaces the token of the account being reconnected (`reconnect`), or on a hosted plane is stored under `/auth/:provider` (`saveHostedKey`);
- a sign-in runs `authorize`, then `callback` (at once for an `auto` grant, after the pasted code for a `code` grant).

Success shows "{vendor} connected", rescans and closes the dialog.

## Flows

- Flow 15, "Models lists each agent's accounts": add two Cursor keys through the dialog, switch between them, remove both (both apps).
- Flow 1 checks the AI step lists the Claude Code card.
