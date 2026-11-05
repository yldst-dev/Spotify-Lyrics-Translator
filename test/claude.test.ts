import { afterAll, beforeEach, expect, test } from "bun:test";
import { createClaudeProvider, providerFromEnv } from "../src/translator";

let responses: Response[] = [];
const requests: { body: Record<string, unknown>; headers: Headers; path: string }[] = [];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    requests.push({ body: (await req.json()) as Record<string, unknown>, headers: req.headers, path: new URL(req.url).pathname });
    return responses.shift() ?? new Response("unset", { status: 500 });
  },
});

afterAll(() => server.stop(true));
beforeEach(() => {
  requests.length = 0;
  responses = [];
});

const provider = (apiKey: string | undefined = "sk-test") =>
  createClaudeProvider({ baseUrl: `http://127.0.0.1:${server.port}/`, apiKey, model: "claude-opus-5-5", effort: "low", retryDelayMs: 1 });

const message = (stop_reason: string, text: string) =>
  Response.json({ stop_reason, content: [{ type: "fallback" }, { type: "text", text }] });

const items = [{ i: 0, text: "hello there" }];

test("sends the documented request and reads the text block", async () => {
  responses = [message("end_turn", '{"lines":[{"i":0,"text":"안녕"}]}')];
  expect(await provider().translate("ko", items)).toEqual([{ i: 0, text: "안녕" }]);
  const { body, headers, path } = requests[0];
  expect(path).toBe("/v1/messages");
  expect(headers.get("x-api-key")).toBe("sk-test");
  expect(headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
  expect(body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "low" } });
});

test("retries rate limits and overload, but not refusals or bad keys", async () => {
  responses = [new Response("busy", { status: 429 }), new Response("busy", { status: 529 }), message("end_turn", '{"lines":[]}')];
  expect(await provider().translate("ko", items)).toEqual([]);
  expect(requests).toHaveLength(3);

  requests.length = 0;
  responses = [message("refusal", "")];
  await expect(provider().translate("ko", items)).rejects.toThrow("Claude stopped with refusal");
  expect(requests).toHaveLength(1);

  requests.length = 0;
  responses = [new Response("nope", { status: 401 })];
  await expect(provider().translate("ko", items)).rejects.toThrow("Claude API 401");
  expect(requests).toHaveLength(1);
});

test("a missing key fails before any request", async () => {
  await expect(createClaudeProvider({ baseUrl: "http://127.0.0.1:1", model: "m", effort: "low" }).translate("ko", items)).rejects.toThrow("ANTHROPIC_API_KEY is not set");
});

test("the provider from env defaults to the current Opus model", () => {
  expect(providerFromEnv({ SLT_TRANSLATOR: "claude", SLT_EFFORT: "low" }).id).toBe("claude:claude-opus-5-5:low");
});
