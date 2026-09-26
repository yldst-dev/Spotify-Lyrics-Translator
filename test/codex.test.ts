import { afterAll, beforeEach, expect, test } from "bun:test";
import { createCodexProvider, parseLines, providerFromEnv, readSse } from "../src/translator";

type Handler = (body: Record<string, unknown>, headers: Headers) => Response;

let handler: Handler = () => new Response("unset", { status: 500 });
const requests: Record<string, unknown>[] = [];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as Record<string, unknown>;
    requests.push(body);
    return handler(body, req.headers);
  },
});

afterAll(() => server.stop(true));
beforeEach(() => {
  requests.length = 0;
});

const baseUrl = `http://127.0.0.1:${server.port}/v1`;
const provider = (apiKey = "cg_test") => createCodexProvider({ baseUrl, apiKey, model: "gpt-6-astra", effort: "low", retryDelayMs: 1 });

const sse = (events: object[], chunkSize = 7) => {
  const text = events.map((e) => `event: ${(e as { type: string }).type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};

const streamOf = (text: string, withDone = true) => {
  const half = Math.ceil(text.length / 2);
  return [
    { type: "response.created" },
    { type: "response.in_progress" },
    { type: "response.output_item.added" },
    { type: "response.content_part.added" },
    { type: "response.output_text.delta", delta: text.slice(0, half) },
    { type: "response.output_text.delta", delta: text.slice(half) },
    ...(withDone ? [{ type: "response.output_text.done", text }] : []),
    { type: "response.content_part.done" },
    { type: "response.output_item.done" },
    { type: "response.completed", response: { output: [] } },
  ];
};

const ANSWER = JSON.stringify({ lines: [{ i: 0, text: "작은 불빛" }, { i: 2, text: "강물이 흐른다" }] });

test("sends the request shape the gateway requires and joins streamed deltas", async () => {
  let auth = "";
  handler = (_body, headers) => {
    auth = headers.get("authorization") ?? "";
    return sse(streamOf(ANSWER, false), 5);
  };

  const result = await provider().translate("ko", [
    { i: 0, text: "a small light" },
    { i: 2, text: "the river runs" },
  ]);

  expect(result).toEqual([
    { i: 0, text: "작은 불빛" },
    { i: 2, text: "강물이 흐른다" },
  ]);
  expect(auth).toBe("Bearer cg_test");
  const body = requests[0];
  expect(body.stream).toBe(true);
  expect(body.store).toBe(false);
  expect(Array.isArray(body.input)).toBe(true);
  expect(typeof body.instructions).toBe("string");
  expect((body.instructions as string).length).toBeGreaterThan(0);
  expect(body.reasoning).toEqual({ effort: "low" });
  expect(body).not.toHaveProperty("temperature");
  expect(body).not.toHaveProperty("max_output_tokens");
  expect(body).not.toHaveProperty("previous_response_id");
});

test("prefers output_text.done over the joined deltas", async () => {
  handler = () =>
    sse([
      { type: "response.output_text.delta", delta: "garbage" },
      { type: "response.output_text.done", text: ANSWER },
      { type: "response.completed", response: { output: [] } },
    ]);
  expect(await provider().translate("ko", [{ i: 0, text: "x" }])).toHaveLength(2);
});

test("retries 502 and succeeds", async () => {
  let calls = 0;
  handler = () => (++calls < 3 ? new Response("upstream request failed", { status: 502 }) : sse(streamOf(ANSWER)));
  expect(await provider().translate("ko", [{ i: 0, text: "x" }])).toHaveLength(2);
  expect(calls).toBe(3);
});

test("does not retry 401", async () => {
  let calls = 0;
  handler = () => {
    calls++;
    return new Response('{"detail":"Invalid API key"}', { status: 401 });
  };
  await expect(provider().translate("ko", [{ i: 0, text: "x" }])).rejects.toThrow("401");
  expect(calls).toBe(1);
});

test("retries a malformed answer, then fails", async () => {
  let calls = 0;
  handler = () => {
    calls++;
    return sse(streamOf("sorry, I cannot"));
  };
  await expect(provider().translate("ko", [{ i: 0, text: "x" }])).rejects.toThrow("no JSON object");
  expect(calls).toBe(3);
});

test("response.failed raises without retry", async () => {
  let calls = 0;
  handler = () => {
    calls++;
    return sse([{ type: "response.failed", response: { error: { message: "limit" } } }]);
  };
  await expect(provider().translate("ko", [{ i: 0, text: "x" }])).rejects.toThrow("response.failed");
  expect(calls).toBe(1);
});

test("missing key fails before any request", async () => {
  await expect(provider("").translate("ko", [{ i: 0, text: "x" }])).rejects.toThrow("CODEX_GATEWAY_API_KEY");
  expect(requests).toHaveLength(0);
});

test("parseLines tolerates fences and drops malformed entries", () => {
  expect(parseLines('```json\n{"lines":[{"i":1,"text":"a"},{"i":"x","text":"b"},{"i":2}]}\n```')).toEqual([{ i: 1, text: "a" }]);
});

test("readSse handles CRLF split across chunks and a trailing event without blank line", async () => {
  const raw = 'data: {"type":"a"}\r\n\r\ndata: {"type":"b"}';
  const bytes = new TextEncoder().encode(raw);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const b of bytes) c.enqueue(new Uint8Array([b]));
      c.close();
    },
  });
  const types: unknown[] = [];
  for await (const event of readSse(body)) types.push(event.type);
  expect(types).toEqual(["a", "b"]);
});

test("providerFromEnv defaults to the codex gateway", () => {
  expect(providerFromEnv({}).id).toBe("codex:gpt-6-astra:medium");
  expect(providerFromEnv({ SLT_TRANSLATOR: "mock" }).id).toBe("mock");
  expect(() => providerFromEnv({ SLT_TRANSLATOR: "nope" })).toThrow();
});
