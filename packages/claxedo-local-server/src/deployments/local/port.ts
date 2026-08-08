/**
 * The default port for the local Claxedo server.
 *
 * NOT 3001. That port is the default of a large share of the dev tooling on a
 * developer's machine (Express boilerplate, NestJS, Payload, Directus, and
 * whatever create-react-app opens in its second tab), so it loses the bind race
 * often. Worse, the desktop app's development attach probe health-checks this
 * port and treats a hit as "the Claxedo server is already running" — on 3001,
 * an unrelated project's server could be adopted as ours.
 *
 * 2593 is "clxd" on a phone keypad (c=2, l=5, x=9, d=3).
 *
 * Keep in sync with `DEFAULT_CLAXEDO_SERVER_PORT` in
 * `packages/claxedo-desktop/src/main/server-port.ts`. If the two disagree, the
 * development attach path breaks: the desktop app probes one port while
 * `claxedo-server dev` listens on another, so `bun dev` silently starts a
 * second, embedded server instead of attaching to the running one.
 */
export const DEFAULT_CLAXEDO_SERVER_PORT = 2593
