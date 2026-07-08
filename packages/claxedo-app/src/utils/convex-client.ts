import { createSignal } from "solid-js";
import { ConvexClient, type AuthTokenFetcher } from "convex/browser";
import { makeFunctionReference, type FunctionReference, type FunctionType } from "convex/server";
import { clerk, getAuthToken, initializeClerk } from "./auth-client";

type ConvexArgs = Record<string, unknown>;

type ConvexTransport = {
  setAuth(fetchToken: AuthTokenFetcher, onChange?: (isAuthenticated: boolean) => void): void;
  query<Result>(fn: FunctionReference<"query", "public", ConvexArgs, Result>, args: ConvexArgs): Promise<Result>;
  mutation<Result>(fn: FunctionReference<"mutation", "public", ConvexArgs, Result>, args: ConvexArgs): Promise<Result>;
  action<Result>(fn: FunctionReference<"action", "public", ConvexArgs, Result>, args: ConvexArgs): Promise<Result>;
  close(): Promise<void>;
}

type CreateConvexClientInput = {
  url?: string | null;
  createClient?: (url: string) => ConvexTransport;
}

function clean(input?: string | null) {
  const value = input?.trim();
  return value ? value : undefined;
}

function envString(input: unknown) {
  return typeof input === "string" ? input : undefined;
}

function envConvexUrl() {
  return clean(envString(import.meta.env.VITE_CONVEX_URL));
}

function reference<Type extends FunctionType, Result>(type: Type, name: string) {
  return makeFunctionReference<Type, ConvexArgs, Result>(name);
}

function unavailable(): never {
  throw new Error("Convex is not configured");
}

export function createClaxedoConvexClient(input: CreateConvexClientInput = {}) {
  const url = clean(input.url) ?? envConvexUrl();
  const createClient = input.createClient ?? ((address: string): ConvexTransport => new ConvexClient(address));
  const transport = url ? createClient(url) : null;
  const [ready, setReady] = createSignal(!transport);
  const [authenticated, setAuthenticated] = createSignal(false);

  const fetchToken: AuthTokenFetcher = async (args) => getAuthToken({
    skipCache: args.forceRefreshToken,
  });

  const applyAuth = () => {
    if (!transport) return;
    transport.setAuth(fetchToken, (isAuthenticated) => {
      setAuthenticated(isAuthenticated);
      setReady(true);
    });
  }

  let closed = false;
  let unsubscribe = () => {};
  applyAuth();
  if (transport) {
    void initializeClerk().then(async () => {
      if (closed) return;
      unsubscribe = clerk.addListener(applyAuth);
      const token = await fetchToken({ forceRefreshToken: false });
      if (!token) setReady(true);
    });
  }

  return {
    enabled: !!transport,
    url,
    client: transport,
    isReady: ready,
    isAuthenticated: authenticated,
    async query<Result = unknown>(name: string, args: ConvexArgs = {}): Promise<Result> {
      if (!transport) unavailable();
      return transport.query(reference<"query", Result>("query", name), args);
    },
    async mutation<Result = unknown>(name: string, args: ConvexArgs = {}): Promise<Result> {
      if (!transport) unavailable();
      return transport.mutation(reference<"mutation", Result>("mutation", name), args);
    },
    async action<Result = unknown>(name: string, args: ConvexArgs = {}): Promise<Result> {
      if (!transport) unavailable();
      return transport.action(reference<"action", Result>("action", name), args);
    },
    async close() {
      closed = true;
      unsubscribe();
      if (!transport) return;
      await transport.close();
    },
  };
}

let defaultClient: ReturnType<typeof createClaxedoConvexClient> | undefined;

export function getClaxedoConvexClient() {
  defaultClient ??= createClaxedoConvexClient();
  return defaultClient;
}

export function resetClaxedoConvexClient() {
  const client = defaultClient;
  defaultClient = undefined;
  return client?.close();
}
