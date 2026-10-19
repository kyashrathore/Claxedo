# Tasks app entry

The code the app ships as the bundled first-party plugin `claxedo-tasks` (`index.ts`, built by `claxedo-app/vite.plugin-bundles.ts`). It runs in the app's realm on the desktop and in the sandboxed plugin frame on the web, and reaches the server only through the plugin API: `server.fetch` on the routes its manifest names (`/api/claxedo/tasks`, `/api/claxedo/plugins`), with the kit's own client (`tasks-client.ts` over `client/client.ts`).

## Owned concepts

- **Transcript cards** (`tool-cards.ts`): the five `task_*` tool card templates.
- **Surface sync** (`surface/sync.ts`): every surface here is drawn from a pure frame (`components`, `data`) of the program's state. The sync sends the first frame whole, then only the components whose JSON changed and a patch per changed data path (order-free comparison). Input fields write the data model inside the app and tell the program nothing until an event, so the sync is told what the app holds (`observe`) when an event carries it, and a redraw never overwrites text the person typed. `force` sends a path unchanged, as a Board `move` refusal needs.
- **Settings → Presets** (`presets/`, section `presets`, `/settings/claxedo-tasks%2Fpresets`): a list of the person's presets (archive and restore as a row toggle, a switch for archived ones) and an editor: name, Local or Cloud, instructions, whether agents may start it, the primary configuration and optional planning, implementation and review ones, each an `AgentConfigurationPicker` the app draws, and for Cloud the plugins and skills from the Marketplace catalog (`presets/catalog.ts`). Every editor event carries the whole draft (`/draft`), so the program's draft always matches what the person sees. Save validates (`presets/draft.ts`); a slot's problem shows at the top of its section, and a Cloud preset naming a harness that runs in its own session host is refused with the kit's reason (`cloudPresetHarnessRefusal`) before it is sent. A `stale_revision` refusal keeps the edits, adopts the current revision and asks to save again. A placement the server does not offer shows a warning; saving keeps the choice.
- **Words** (`dictionary.ts`, `words/`): the plugin's `en` dictionary, merged from the card, common and preset words.

## State

`presets/state.ts`: the list (`loading`, `ready`, `failed`), the catalog (`idle`, `loading`, `ready`, `failed`) and the editor (`closed`, or `open` with its draft, problems, `saving`, refusal and whether it changed elsewhere). The program changes state only by partial patches applied to the latest state, so an answer that lands late never restores an older one.

## Flows

63 Settings → Presets (`e2e/flows/63-tasks-presets.spec.ts`, web and phone).
