import { credentialBrokerErrorCode } from "@claxedo/agent-runtime-contract"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  providerBinding,
  providerProjectionKey,
  type ProviderBinding,
  type ProviderProjection,
} from "../../provider-projection"

/** The provider id the brokered config declares and every brokered thread selects. */
export const CODEX_BROKER_PROVIDER = "broker"

/**
 * The app-server config a brokered turn runs under.
 *
 * `requires_openai_auth = false` is what lets the app-server talk to a provider
 * it never logged into: without it the client refuses to start a turn until an
 * account exists, and no account is what a brokered turn is for. `wire_api =
 * "responses"` is the protocol both the API host and the ChatGPT Codex backend
 * speak, and the Authorization header carries the binding's placeholder, which
 * the broker replaces with the real token on its way to the vendor.
 */
export function codexBrokerConfig(binding: ProviderBinding): string {
  return [
    `model_provider = ${JSON.stringify(CODEX_BROKER_PROVIDER)}`,
    "",
    `[model_providers.${CODEX_BROKER_PROVIDER}]`,
    'name = "Claxedo credential broker"',
    `base_url = ${JSON.stringify(`${binding.baseUrl}${binding.apiPath ?? ""}`)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    `http_headers = { Authorization = ${JSON.stringify(`Bearer ${binding.placeholder}`)} }`,
    "",
  ].join("\n")
}

/**
 * A Codex home holding the brokered provider and nothing else.
 *
 * Never the operator's `~/.codex`: the app-server would find their `auth.json`
 * there and run the turn on that account, and it writes into whatever home it is
 * given, so pointing it at theirs would also mutate it. The directory is rebuilt
 * on every launch because the placeholder it carries expires.
 */
export function writeCodexBrokerHome(root: string, binding: ProviderBinding): string {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(root, "config.toml"), codexBrokerConfig(binding), { mode: 0o600 })
  return root
}

/**
 * Which account the next app-server launch runs on, and the home that decides
 * it. A live process holds the provider it started with, so the driver asks
 * this whether a config apply has to replace the process.
 */
export class CodexBrokerProvider {
  private projection: ProviderProjection | undefined
  private readonly root: string

  constructor(root?: string) {
    this.root = root ?? path.join(os.homedir(), ".claxedo", "codex", "home")
  }

  /** True when what the next launch must run on differs from what is running. */
  replace(projection: ProviderProjection | undefined): boolean {
    if (providerProjectionKey(projection) === providerProjectionKey(this.projection)) return false
    this.projection = projection
    return true
  }

  /** Whether a thread must select the brokered provider rather than the default. */
  get selected() {
    return this.projection !== undefined
  }

  /** The `CODEX_HOME` for the next launch; the operator's only when nothing is bound. */
  home(operatorHome: string): string {
    const binding = providerBinding("codex", this.projection)
    return binding ? writeCodexBrokerHome(this.root, binding) : operatorHome
  }
}

/**
 * What a 401 on Codex's stderr means, as the turn's error.
 *
 * A line that already names a broker code is passed through: the code says what
 * was refused, and the classifier reads it. Replacing it with a login
 * instruction throws that away and sends the operator to re-authenticate an
 * account a brokered turn never uses — `codex login` writes the operator's own,
 * which is exactly the one the broker withholds.
 */
export function codexAuthFailure(stderr: string, brokered: boolean): string {
  if (credentialBrokerErrorCode(stderr)) return stderr
  return brokered
    ? "Codex authentication failed with 401 Unauthorized: the vendor refused the credential binding this turn ran on."
    : "Codex authentication failed with 401 Unauthorized. Run `codex login` or sync a valid Codex credential, then retry."
}
