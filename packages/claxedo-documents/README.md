# @claxedo/documents

The Documents plugin, a first-party plugin with its id, `claxedo-documents`, reserved in `FIRST_PARTY_PLUGIN_IDS`. It holds the Documents backend: the document port, its index and history, the local repository and managed backends, the hosted R2 backend, the `/documents` and `/p` routes, the workspace runtime's hydration of a session's documents, the agent tools, the `claxedo documents` CLI command and the `documents.*` hosted operations. The hosts (the desktop's local server, the hosted Worker, the sandbox's workspace runtime and `claxedo-host-serving`, the CLI, the desktop's account bridge and the app's operation table) compose it and keep no Documents code of their own. Documents has no page in the app; its app entry only draws its two transcript cards.

## Subpaths, by host role

| Subpath | What | Composed by |
| --- | --- | --- |
| `./host/*` | The backend, one specifier per module: the port (`port`, `errors`, `version`, `index-contract`), the SQLite index store, history and snapshot pins, the access policy, the service, session grants and hydration, the repository and local managed backends, and the routes (`routes/index` for `/documents`, `routes/public` for `/p`) | `./local`, `./hosted`, host adapters |
| `./local` | `createLocalDocumentsPlugin()`: a `LocalServerPlugin` mounting `/documents` over this machine's workspaces, with the MCP group and the `documents` service grant; `documentGit`, the backend's git through the runtime's `runGit` | `claxedo-desktop/src/server/entry.ts`, the e2e daemon entry |
| `./hosted` | `createHostedDocumentsPlugin(ports)`: a `HostedServerPlugin` with the R2 backend (`CLAXEDO_DOCUMENTS`), the hosted document and project indexes, `/documents` and `/p`; `HOSTED_DOCUMENTS_PLUGIN_BASE`, the half no port shapes, so a catalog lists the group before a deployment builds the plugin | `claxedo-server/src/documents/compose.ts`, called by the core Worker root |
| `./runtime` | `createDocumentHydration(options)` and `documentHydrationContribution(hydration)`: the hydration routes a relay-exposed runtime serves, and the write-back after each turn (`turnSettled`) and before each delete (`beforeSessionDelete`) | the sandbox's `runtime-boot.ts`, `claxedo-host-serving/src/runtime.ts` |
| `./mcp` | `DOCUMENTS_MCP_TOOL_GROUP`: `documents_list` and `documents_open` | every server plugin, and the sandbox runtime |
| `./cli` | `documentsCliCommand`: `claxedo documents list` and `open` | `cli/src/plugin-commands.ts` |
| `./operations` | `DOCUMENTS_OPERATIONS`, the `documents.*` hosted operation definitions, built with `@claxedo/account-contract/operation-definition`; `documents.export` answers bytes | `claxedo-desktop/src/main/account/hosted-operations.ts`, `claxedo-app/src/server/operations.ts` |
| `./testing` | `documentTestAccess` and `documentAuthorizedFetch` for the host composition tests | tests |

The app entry is not an export: `src/app/index.ts` is named by the `claxedo` manifest block in `package.json` (`requires: ["documents"]`, no routes or operations) and built only by `claxedo-app/vite.plugin-bundles.ts`. It registers the `documents_list` and `documents_open` card templates and their `en` dictionary. The product-boundary policy `documents-app` (`bun run verify:closure` here) keeps it to the plugin API.

## Ports a hosted deployment implements

`HostedDocumentsPorts` (`src/hosted/plugin.ts`): the R2 `bucket`, `env`, the `services` whose authority is read at request time, the request `authentication`, `access` (who may read, edit and share, decided by the deployment's own authority over organizations and teams: `d1DocumentAccess` in `claxedo-server/src/authority/adapters/d1/document-authority.ts`), `runtime` (how a session's runtime is reached to hydrate and resolve: `createHostedDocumentRuntimeBroker` in `claxedo-server/src/documents/runtime-broker.ts`) and `rateLimit` for public page reads.

## Rules the code keeps

- **Dependency direction.** This package imports only the host contracts (`@claxedo/plugin-api`, `@claxedo/server-core`, `@claxedo/session-core`, `@claxedo/workspace-runtime/route-contribution`, `@claxedo/workspace-runtime/host` for `runGit`, `@claxedo/mcp/tool-group`, `@claxedo/account-contract/operation-definition`, `@claxedo/helpers`), and no core package imports it. `script/first-party-plugins.test.ts` enforces both.
- **Storage stays with the host.** The document tables are not this package's: the host journal's document migrations (`20260716000100_documents_reset`, `20261001000100_document_creator`) interleave with host tables, so moving them would change migration ids and order. `claxedo_document_index` and `claxedo_page_status` are declared in `claxedo-server-core/src/documents/index.sql.ts` and repaired by `platform/db/repair.ts`, and the D1 `document_shares` table stays in the host baseline beside the organization and team tables `d1DocumentAccess` joins.
- **Persisted contracts.** The `CLAXEDO_DOCUMENTS` binding, its object keys, the MCP group id `documents`, the tool names and the `claxedo.account.operation:documents.*` IPC channels are unchanged from when this code lived in the hosts.

## Tests

`bun run test` runs the service, index, routes, backends, private pages, session grants, hydration and the legacy guards under Bun; `src/local/plugin.test.ts` runs in a process of its own, because it plants its environment before `workspace-runtime/src/git.ts` loads. The miniflare, workerd and D1 authority tests stay in `claxedo-server` as host composition tests.
