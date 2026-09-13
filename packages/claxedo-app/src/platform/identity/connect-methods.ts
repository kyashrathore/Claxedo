/**
 * What each vendor's sign-in methods are, and how a reader obtains one.
 *
 * The server decides which methods a provider has and gives each an index that
 * `provider.oauth.authorize` is keyed by, but it names them for an operator —
 * "ChatGPT Pro/Plus (headless)" says nothing about which plan pays for it or
 * where the key comes from. This table carries only the words, the commands
 * and the key pages, joined to the server's list by method type so the index
 * survives; it never adds a method the server did not offer.
 */

export type ConnectMethodType = "oauth" | "token" | "api"

export type ConnectMethodSpec = {
  type: ConnectMethodType
  /** i18n base: the card reads `${copy}.title`, `${copy}.for` and `${copy}.how`. */
  copy: string
  /** Minted in a terminal, shown in a copyable field. The server's own command wins. */
  command?: string
  /** The vendor's key page, opened in the reader's browser. */
  url?: string
}

type ConnectVendor = {
  /** Registry ids this vendor's login is stored under, harness auth ids included. */
  providers: readonly string[]
  /** Display order on the card. */
  methods: readonly ConnectMethodSpec[]
}

const VENDORS: readonly ConnectVendor[] = [
  {
    providers: ["anthropic", "claude-sdk", "claude-acp"],
    methods: [
      { type: "token", copy: "provider.connect.method.anthropic.subscription", command: "claude setup-token" },
      { type: "api", copy: "provider.connect.method.anthropic.apiKey", url: "https://platform.claude.com/settings/keys" },
    ],
  },
  {
    providers: ["openai", "openai-codex", "codex-app-server"],
    methods: [
      { type: "oauth", copy: "provider.connect.method.openai.plan" },
      { type: "api", copy: "provider.connect.method.openai.apiKey", url: "https://platform.openai.com/api-keys" },
    ],
  },
  {
    providers: ["cursor", "cursor-sdk", "cursor-acp"],
    methods: [
      { type: "api", copy: "provider.connect.method.cursor.apiKey", url: "https://cursor.com/dashboard/api" },
    ],
  },
  {
    providers: ["openrouter"],
    methods: [{ type: "api", copy: "provider.connect.method.openrouter.apiKey", url: "https://openrouter.ai/keys" }],
  },
  {
    providers: ["google", "google-generative-ai"],
    methods: [{ type: "api", copy: "provider.connect.method.google.apiKey", url: "https://aistudio.google.com/apikey" }],
  },
  {
    providers: ["groq"],
    methods: [{ type: "api", copy: "provider.connect.method.groq.apiKey", url: "https://console.groq.com/keys" }],
  },
  {
    providers: ["xai"],
    methods: [{ type: "api", copy: "provider.connect.method.xai.apiKey", url: "https://console.x.ai/team/default/api-keys" }],
  },
]

/** The words for a method this table has no vendor entry for. `{{vendor}}` names it. */
const GENERIC: readonly ConnectMethodSpec[] = [
  { type: "oauth", copy: "provider.connect.method.generic.oauth" },
  { type: "token", copy: "provider.connect.method.generic.token" },
  { type: "api", copy: "provider.connect.method.generic.apiKey" },
]

function genericSpec(type: string): ConnectMethodSpec {
  return GENERIC.find((spec) => spec.type === type) ?? GENERIC[GENERIC.length - 1]
}

function vendorMethods(providerId: string): readonly ConnectMethodSpec[] {
  return VENDORS.find((vendor) => vendor.providers.includes(providerId))?.methods ?? []
}

/** One method as the card offers it: the server's index, with the words for it. */
export type ConnectMethodOption = {
  /** Index in the server's method list. `oauth.authorize`/`callback` are keyed by it. */
  index: number
  type: string
  /** The server's own name, shown when this table has no title for the method. */
  label: string
  spec: ConnectMethodSpec
  command?: string
}

export type ServerAuthMethod = { type?: string; label?: string; command?: string }

/**
 * The server's methods in the table's display order, each carrying its words.
 *
 * A method the table names but the server does not offer is dropped: without
 * the server's index there is nothing to authorize against. A method the table
 * has never heard of keeps its place at the end under the generic words.
 */
export function connectMethodOptions(
  providerId: string,
  methods: readonly ServerAuthMethod[],
): ConnectMethodOption[] {
  const taken: number[] = []
  const option = (index: number, spec: ConnectMethodSpec): ConnectMethodOption => {
    const method = methods[index]
    taken.push(index)
    return {
      index,
      type: method.type ?? spec.type,
      label: method.label ?? "",
      spec,
      command: method.command ?? spec.command,
    }
  }

  const named = vendorMethods(providerId).flatMap((spec) => {
    const index = methods.findIndex((method, at) => method.type === spec.type && !taken.includes(at))
    return index === -1 ? [] : [option(index, spec)]
  })
  const rest = methods.flatMap((method, index) =>
    taken.includes(index) ? [] : [option(index, genericSpec(method.type ?? "api"))])

  return [...named, ...rest]
}

/**
 * The methods to offer when the server names none for this provider.
 *
 * `/providers/auth` answers for the providers a login can be stored against,
 * which is fewer than the vendors an engine can run models from, and the
 * answer can also fail to arrive. Everything a reader pastes needs no answer
 * from it: the command that mints a subscription token and the vendor's key
 * page are both in the table above. Only OAuth needs the server's index, so it
 * is left out.
 */
export function fallbackConnectMethods(
  providerId: string,
): { type: ConnectMethodType; label: string; command?: string }[] {
  const pasted = vendorMethods(providerId).filter((spec) => spec.type !== "oauth")
  const specs = pasted.length > 0 ? pasted : [genericSpec("api")]
  return specs.map((spec) => ({ type: spec.type, label: "", ...(spec.command ? { command: spec.command } : {}) }))
}

/** Every i18n base this table can ask for, so locale coverage is checked against the table itself. */
export const CONNECT_METHOD_COPY_BASES: readonly string[] = [
  ...VENDORS.flatMap((vendor) => vendor.methods.map((method) => method.copy)),
  ...GENERIC.map((method) => method.copy),
]

/** Every key page this table links to, so their shape is checked in one place. */
export const CONNECT_METHOD_URLS: readonly string[] = VENDORS
  .flatMap((vendor) => vendor.methods.flatMap((method) => (method.url ? [method.url] : [])))
