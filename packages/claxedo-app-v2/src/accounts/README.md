# Accounts

Owns: the logins each agent harness runs on, and today's app's surfaces for them: Settings → Models (`modelsSettingsSection`, registered in the shell's settings sections) and the account cards the first run's AI step shows. Both render the same `AgentHarnessAccounts`.

## Data

- `useAccounts()` (`store.ts`) reads three adapter queries: stored accounts (`server.queries.accounts.list`), the ones in use (`effective`) and this machine's CLI logins (`machineLogins`). Nothing reads them at app start: the machine-login read starts the harness CLIs, so it runs only when Settings → Models or the AI step mounts.
- Rescan asks every CLI again (`server.accounts.rescan`, `fresh=1`) and rereads the stored rows. Select, remove and check go through `server.accounts`; a failed write is a "Request failed" toast.
- A live check of a stored account is kept on the page (`liveChecks`) and outranks the verdict the server stored; a check that never reached the provider is kept as `unknown` with its reason.
- `model.ts` holds the harness list (Claude Code, Codex, Cursor) and the rules: which row is selected (the server's effective read first, then the stored mark, then this computer's login), whether a login is refused or unavailable, whether this computer's login would strand a binding, and whether a harness can run a turn (`harnessRunnable`).
- `account-words.ts` turns a row into what the row says: label, second line (verdict, plan windows), hint, alert and reach.

## Connect

"Add an account" and "Reconnect" open `DialogProviderConnect`. `createProviderConnect` (`connect-form.ts`) lists the provider's methods from `server.queries.providerConnect.authMethods(harness)`, joined by type to the vendor copy in `connect-methods.ts` (with a pasted-key fallback when the server lists none), and then:

- a key or subscription token is saved as a managed credential with the user's label (`saveKey`), replaces the token of the account being reconnected (`reconnect`), or on a hosted plane is stored under `/auth/:provider` (`saveHostedKey`);
- a sign-in runs `authorize`, then `callback` (at once for an `auto` grant, after the pasted code for a `code` grant).

Success shows "{vendor} connected", rescans and closes the dialog.

## Flows

- Flow 15, "Models lists each agent's accounts": add two Cursor keys through the dialog, switch between them, remove both (both apps).
- Flow 1 checks the AI step lists the Claude Code card.
