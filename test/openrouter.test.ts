import { afterAll, beforeEach, expect, test } from "bun:test";
import { createOpenRouterProvider, providerFromEnv } from "../src/translator";

let handler: (body: Record<string, unknown>, headers: Headers) => Response | Promise<Response> = () => new Response("unset", { status: 500 });
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

const provider = (apiKey = "sk-or-test") =>
  createOpenRouterProvider({ baseUrl: `http://127.0.0.1:${server.port}/api/v1`, apiKey, model: "openai/gpt-6-luna", effort: "low", retryDelayMs: 1 });

const completion = (content: string, finish_reason = "stop") =>
  Response.json({ id: "gen-1", choices: [{ finish_reason, message: { role: "assistant", content } }] });

const ANSWER = JSON.stringify({ lines: [{ i: 0, text: "작은 불빛" }] });

test("sends chat completions with strict json_schema, required parameters, and hidden reasoning", async () => {
  let auth = "";
  handler = (_body, headers) => {
    auth = headers.get("authorization") ?? "";
    return completion(ANSWER);
  };

  expect(await provider().translate("ko", [{ i: 0, text: "a small light" }])).toEqual([{ i: 0, text: "작은 불빛" }]);

  const body = requests[0];
  expect(auth).toBe("Bearer sk-or-test");
  expect(body.model).toBe("openai/gpt-6-luna");
  expect((body.messages as { role: string }[]).map((m) => m.role)).toEqual(["system", "user"]);
  expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "lyrics_translation", strict: true } });
  expect(body.provider).toEqual({ require_parameters: true });
  expect(body.reasoning).toEqual({ effort: "low", exclude: true });
});

test("retries 429 and 5xx", async () => {
  let calls = 0;
  handler = () => {
    calls++;
    if (calls === 1) return new Response('{"error":{"code":429,"message":"rate"}}', { status: 429 });
    if (calls === 2) return new Response("bad gateway", { status: 502 });
    return completion(ANSWER);
  };
  expect(await provider().translate("ko", [{ i: 0, text: "x" }])).toHaveLength(1);
  expect(calls).toBe(3);
});

test("does not retry 401 or 402", async () => {
  for (const status of [401, 402]) {
    let calls = 0;
    handler = () => {
      calls++;
      return new Response(`{"error":{"code":${status},"message":"no"}}`, { status });
    };
    await expect(provider().translate("ko", [{ i: 0, text: "x" }])).rejects.toThrow(String(status));
    expect(calls).toBe(1);
  }
});

test("treats an error object inside a 200 response by its code", async () => {
  let calls = 0;
  handler = () => {
    calls++;
    return calls === 1 ? Response.json({ error: { code: 502, message: "upstream" } }) : completion(ANSWER);
  };
  expect(await provider().translate("ko", [{ i: 0, text: "x" }])).toHaveLength(1);
  expect(calls).toBe(2);

  calls = 0;
  handler = () => {
    calls++;
    return Response.json({ error: { code: 400, message: "bad" } });
  };
  await expect(provider().translate("ko", [{ i: 0, text: "x" }])).rejects.toThrow("400");
  expect(calls).toBe(1);
});

test("a cut-off answer fails without retry", async () => {
  let calls = 0;
  handler = () => {
    calls++;
    return completion('{"lines":[', "length");
  };
  await expect(provider().translate("ko", [{ i: 0, text: "x" }])).rejects.toThrow("cut off");
  expect(calls).toBe(1);
});

test("aborting stops the request", async () => {
  handler = async () => {
    await Bun.sleep(1000);
    return completion(ANSWER);
  };
  const controller = new AbortController();
  const pending = provider().translate("ko", [{ i: 0, text: "x" }], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await expect(pending).rejects.toThrow();
  expect(requests).toHaveLength(1);
});

test("missing key fails before any request", async () => {
  await expect(provider("").translate("ko", [{ i: 0, text: "x" }])).rejects.toThrow("OPENROUTER_API_KEY");
  expect(requests).toHaveLength(0);
});

test("providerFromEnv builds openrouter with defaults and overrides", () => {
  expect(providerFromEnv({ SLT_TRANSLATOR: "openrouter" }).id).toBe("openrouter:openai/gpt-6-luna:medium");
  expect(providerFromEnv({ SLT_TRANSLATOR: "openrouter", OPENROUTER_MODEL: "deepseek/deepseek-v4.1-flash", SLT_EFFORT: "low" }).id).toBe(
    "openrouter:deepseek/deepseek-v4.1-flash:low",
  );
});
