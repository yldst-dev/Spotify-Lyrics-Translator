import { afterAll, beforeEach, expect, test } from "bun:test";
import { createOpenAIProvider, providerFromEnv } from "../src/translator";

let responses: Response[] = [];
const requests: { body: Record<string, unknown>; auth: string | null; path: string }[] = [];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    requests.push({ body: (await req.json()) as Record<string, unknown>, auth: req.headers.get("authorization"), path: new URL(req.url).pathname });
    return responses.shift() ?? new Response("unset", { status: 500 });
  },
});

afterAll(() => server.stop(true));
beforeEach(() => {
  requests.length = 0;
  responses = [];
});

const provider = (apiKey: string | undefined = "sk-test") =>
  createOpenAIProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1/`, apiKey, model: "gpt-6-luna", effort: "low", retryDelayMs: 1 });

const sse = (...events: object[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

const answer = (text: string) => sse({ type: "response.output_text.delta", delta: text }, { type: "response.output_text.done", text }, { type: "response.completed" });
const items = [{ i: 0, text: "hello there" }];

test("calls the Responses API with a strict schema and reads the stream", async () => {
  responses = [answer('{"lines":[{"i":0,"text":"안녕"}]}')];
  expect(await provider().translate("ko", items)).toEqual([{ i: 0, text: "안녕" }]);
  const { body, auth, path } = requests[0];
  expect(path).toBe("/v1/responses");
  expect(auth).toBe("Bearer sk-test");
  expect(body).toMatchObject({
    model: "gpt-6-luna",
    store: false,
    stream: true,
    reasoning: { effort: "low" },
    text: { format: { type: "json_schema", name: "lyrics_translation", strict: true } },
  });
  expect(body).not.toHaveProperty("service_tier");
});

test("rate limits and server errors are retried, a bad key is not", async () => {
  responses = [new Response("slow", { status: 429 }), new Response("boom", { status: 500 }), answer('{"lines":[]}')];
  expect(await provider().translate("ko", items)).toEqual([]);
  expect(requests).toHaveLength(3);

  requests.length = 0;
  responses = [new Response("nope", { status: 401 })];
  await expect(provider().translate("ko", items)).rejects.toThrow("openai 401");
  expect(requests).toHaveLength(1);
});

test("a refusal or a cut-off answer fails once instead of being billed again", async () => {
  for (const type of ["response.refusal.done", "response.incomplete", "response.failed", "error"]) {
    requests.length = 0;
    responses = [sse({ type })];
    await expect(provider().translate("ko", items)).rejects.toThrow(type);
    expect(requests).toHaveLength(1);
  }
});

test("a missing key fails before any request", async () => {
  await expect(provider("").translate("ko", items)).rejects.toThrow("OPENAI_API_KEY is not set");
  expect(requests).toHaveLength(0);
});

test("the provider from env has working defaults and overrides", () => {
  expect(providerFromEnv({ SLT_TRANSLATOR: "openai" }).id).toBe("openai:gpt-6-luna:medium");
  expect(providerFromEnv({ SLT_TRANSLATOR: "openai", OPENAI_MODEL: "gpt-6-astra", SLT_EFFORT: "high" }).id).toBe("openai:gpt-6-astra:high");
});
