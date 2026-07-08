import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";

let token = "tok_convex";
let listener: (() => void) | undefined;
let unsubscribeCount = 0;
const tokenArgs: Array<{ template?: string; skipCache?: boolean }> = [];

mock.module("./auth-client", () => ({
  clerk: {
    addListener(callback: () => void) {
      listener = callback;
      return () => {
        unsubscribeCount += 1;
      };
    },
  },
  initializeClerk: async () => {},
  getAuthToken: async (args?: { template?: string; skipCache?: boolean }) => {
    tokenArgs.push(args ?? {});
    return token;
  },
  useAuth: () => ({
    isSignedIn: () => !!token,
    loading: () => false,
    session: () => null,
    user: () => null,
  }),
  waitForClerk: async () => {},
}));

const {
  createClaxedoConvexClient,
} = await import(`${import.meta.dir}/convex-client.ts?test`);

function createFakeTransport() {
  const authFetchers: Array<(args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>> = [];
  const authCallbacks: Array<(isAuthenticated: boolean) => void> = [];
  const calls: Array<{
    kind: "query" | "mutation" | "action";
    name: string;
    args: Record<string, unknown>;
  }> = [];

  return {
    authFetchers,
    authCallbacks,
    calls,
    transport: {
      setAuth(fetchToken: (args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>, onChange?: (isAuthenticated: boolean) => void) {
        authFetchers.push(fetchToken);
        authCallbacks.push(onChange ?? (() => {}));
      },
      async query(fn: FunctionReference<"query">, args: Record<string, unknown>) {
        calls.push({ kind: "query", name: getFunctionName(fn), args });
        return { ok: true };
      },
      async mutation(fn: FunctionReference<"mutation">, args: Record<string, unknown>) {
        calls.push({ kind: "mutation", name: getFunctionName(fn), args });
        return { id: "mut_1" };
      },
      async action(fn: FunctionReference<"action">, args: Record<string, unknown>) {
        calls.push({ kind: "action", name: getFunctionName(fn), args });
        return { id: "act_1" };
      },
      async close() {},
    },
  };
}

beforeEach(() => {
  token = "tok_convex";
  listener = undefined;
  unsubscribeCount = 0;
  tokenArgs.length = 0;
});

describe("createClaxedoConvexClient", () => {
  test("stays disabled when no Convex URL is configured", async () => {
    const client = createClaxedoConvexClient({ url: "" });

    expect(client.enabled).toBe(false);
    expect(client.client).toBeNull();
    expect(client.isReady()).toBe(true);
    expect(client.isAuthenticated()).toBe(false);
    await expect(client.query("users:me")).rejects.toThrow("Convex is not configured");
  });

  test("binds Clerk token refreshes into Convex auth", async () => {
    const fake = createFakeTransport();
    const client = createClaxedoConvexClient({
      url: "https://claxedo.example.convex.cloud",
      createClient: () => fake.transport,
    });

    expect(client.enabled).toBe(true);
    expect(client.isReady()).toBe(false);
    expect(fake.authFetchers).toHaveLength(1);
    expect(await fake.authFetchers[0]({ forceRefreshToken: true })).toBe("tok_convex");
    expect(tokenArgs[0]).toEqual({ skipCache: true });

    fake.authCallbacks[0](true);
    expect(client.isReady()).toBe(true);
    expect(client.isAuthenticated()).toBe(true);

    listener?.();
    expect(fake.authFetchers).toHaveLength(2);
    token = "tok_next";
    expect(await fake.authFetchers[1]({ forceRefreshToken: false })).toBe("tok_next");

    await client.close();
    expect(unsubscribeCount).toBe(1);
  });

  test("calls Convex functions by stable module names without generated api", async () => {
    const fake = createFakeTransport();
    const client = createClaxedoConvexClient({
      url: "https://claxedo.example.convex.cloud",
      createClient: () => fake.transport,
    });

    expect(await client.query("users:me")).toEqual({ ok: true });
    expect(await client.mutation("workspaces:createCloud", { workspace_id: "ws_1" })).toEqual({ id: "mut_1" });
    expect(await client.action("runtime:mintToken", { workspace_id: "ws_1" })).toEqual({ id: "act_1" });

    expect(fake.calls).toEqual([
      { kind: "query", name: "users:me", args: {} },
      { kind: "mutation", name: "workspaces:createCloud", args: { workspace_id: "ws_1" } },
      { kind: "action", name: "runtime:mintToken", args: { workspace_id: "ws_1" } },
    ]);
  });
});
