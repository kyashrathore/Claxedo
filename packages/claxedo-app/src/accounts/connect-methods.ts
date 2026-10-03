import type { ProviderAuthMethod } from "@/server"
import type { AccountsKey } from "./i18n"

type ConnectMethodType = "oauth" | "token" | "api"

type MethodCopy = { readonly title: AccountsKey; readonly for: AccountsKey; readonly how: AccountsKey }

export type ConnectMethodSpec = {
  readonly type: ConnectMethodType
  readonly copy: MethodCopy
  readonly command?: string
  readonly url?: string
}

const copy = <B extends string>(base: B) =>
  ({ title: `${base}.title`, for: `${base}.for`, how: `${base}.how` }) as { readonly title: `${B}.title`; readonly for: `${B}.for`; readonly how: `${B}.how` }

type ConnectVendor = { readonly providers: readonly string[]; readonly methods: readonly ConnectMethodSpec[] }

const VENDORS: readonly ConnectVendor[] = [
  {
    providers: ["anthropic", "claude-sdk", "claude-acp"],
    methods: [
      { type: "token", copy: copy("provider.connect.method.anthropic.subscription"), command: "claude setup-token" },
      { type: "api", copy: copy("provider.connect.method.anthropic.apiKey"), url: "https://platform.claude.com/settings/keys" },
    ],
  },
  {
    providers: ["openai", "openai-codex", "codex-app-server"],
    methods: [
      { type: "oauth", copy: copy("provider.connect.method.openai.plan") },
      { type: "api", copy: copy("provider.connect.method.openai.apiKey"), url: "https://platform.openai.com/api-keys" },
    ],
  },
  { providers: ["cursor", "cursor-sdk", "cursor-acp"], methods: [{ type: "api", copy: copy("provider.connect.method.cursor.apiKey"), url: "https://cursor.com/dashboard/api" }] },
  { providers: ["openrouter"], methods: [{ type: "api", copy: copy("provider.connect.method.openrouter.apiKey"), url: "https://openrouter.ai/keys" }] },
  { providers: ["google", "google-generative-ai"], methods: [{ type: "api", copy: copy("provider.connect.method.google.apiKey"), url: "https://aistudio.google.com/apikey" }] },
  { providers: ["groq"], methods: [{ type: "api", copy: copy("provider.connect.method.groq.apiKey"), url: "https://console.groq.com/keys" }] },
  { providers: ["xai"], methods: [{ type: "api", copy: copy("provider.connect.method.xai.apiKey"), url: "https://console.x.ai/team/default/api-keys" }] },
]

const GENERIC_API: ConnectMethodSpec = { type: "api", copy: copy("provider.connect.method.generic.apiKey") }

const GENERIC: readonly ConnectMethodSpec[] = [
  { type: "oauth", copy: copy("provider.connect.method.generic.oauth") },
  { type: "token", copy: copy("provider.connect.method.generic.token") },
  GENERIC_API,
]

function genericSpec(type: string): ConnectMethodSpec {
  return GENERIC.find((spec) => spec.type === type) ?? GENERIC_API
}

function vendorMethods(providerId: string): readonly ConnectMethodSpec[] {
  return VENDORS.find((vendor) => vendor.providers.includes(providerId))?.methods ?? []
}

export type ConnectMethodOption = {
  readonly index: number
  readonly type: string
  readonly label: string
  readonly spec: ConnectMethodSpec
  readonly command?: string
}

export function connectMethodOptions(providerId: string, methods: readonly ProviderAuthMethod[]): ConnectMethodOption[] {
  const taken: number[] = []
  const option = (index: number, spec: ConnectMethodSpec): ConnectMethodOption => {
    const method = methods[index]
    taken.push(index)
    const command = method?.command ?? spec.command
    return { index, type: method?.type ?? spec.type, label: method?.label ?? "", spec, ...(command ? { command } : {}) }
  }
  const named = vendorMethods(providerId).flatMap((spec) => {
    const index = methods.findIndex((method, at) => method.type === spec.type && !taken.includes(at))
    return index === -1 ? [] : [option(index, spec)]
  })
  const rest = methods.flatMap((method, index) => (taken.includes(index) ? [] : [option(index, genericSpec(method.type))]))
  return [...named, ...rest]
}
