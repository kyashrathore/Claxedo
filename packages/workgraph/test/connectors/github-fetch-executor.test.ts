import { vi, describe, it, expect, afterEach } from "vitest";
import { FetchGitHubExecutor } from "../../src/connectors/github/github";

function jsonResponse(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FetchGitHubExecutor", () => {
  it("resolves the token per request so rotation works across calls", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const tokens = ["token-one", "token-two"];
    const getToken = vi.fn(async () => tokens.shift()!);
    const executor = new FetchGitHubExecutor({ getToken });

    const first = await executor.proxy({ endpoint: "/user", method: "GET" });
    const second = await executor.proxy({ endpoint: "/user", method: "GET" });

    expect(first).toEqual({ data: { ok: true } });
    expect(second).toEqual({ data: { ok: true } });
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const headerOf = (call: number) =>
      ((fetchMock.mock.calls[call] as unknown as [URL, RequestInit])[1].headers as Record<string, string>)
        .Authorization;
    expect(headerOf(0)).toBe("Bearer token-one");
    expect(headerOf(1)).toBe("Bearer token-two");
  });

  it("sends Accept header, query params, and JSON body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    const executor = new FetchGitHubExecutor({ getToken: async () => "tok" });
    await executor.proxy({
      endpoint: "/search/issues",
      method: "POST",
      body: { title: "hello" },
      parameters: [
        { in: "query", name: "per_page", value: 20 },
        { in: "header", name: "X-Custom", value: "yes" },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.github.com/search/issues?per_page=20");
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.github.v3+json");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["X-Custom"]).toBe("yes");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ title: "hello" }));
    expect(init.method).toBe("POST");
  });

  it("reports auth failure and throws on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { message: "Bad credentials" })));

    const reportAuthFailure = vi.fn(async () => {});
    const executor = new FetchGitHubExecutor({ getToken: async () => "stale", reportAuthFailure });

    await expect(executor.proxy({ endpoint: "/user", method: "GET" })).rejects.toThrow(/401/);
    expect(reportAuthFailure).toHaveBeenCalledTimes(1);
    expect(reportAuthFailure).toHaveBeenCalledWith(expect.stringContaining("401"));
  });

  it("throws on non-401 errors without reporting auth failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, {})));

    const reportAuthFailure = vi.fn(async () => {});
    const executor = new FetchGitHubExecutor({ getToken: async () => "tok", reportAuthFailure });

    await expect(executor.proxy({ endpoint: "/user", method: "GET" })).rejects.toThrow(/500/);
    expect(reportAuthFailure).not.toHaveBeenCalled();
  });
});
