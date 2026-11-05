import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPOTIFY_ORIGIN } from "../src/config";
import { loadToken } from "../src/patcher";

const ROOT = join(import.meta.dir, "..");
const ENV_START = "# my comment\nSLT_EFFORT=low\nCODEX_GATEWAY_BASE_URL=http://127.0.0.1:1/v1\nCODEX_GATEWAY_API_KEY=old-secret-key\n";

let dir: string;
let envFile: string;
let token: string;
let base: string;
let daemon: ReturnType<typeof Bun.spawn>;
const seen: { auth: string | null; host: string }[] = [];
let gatewayStatus = 200;

const gateway = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    seen.push({ auth: req.headers.get("authorization"), host: new URL(req.url).host });
    if (gatewayStatus !== 200) return new Response("denied", { status: gatewayStatus });
    const { input } = (await req.json()) as { input: { content: string }[] };
    const lines = (JSON.parse(input[0].content).lines as { i: number }[]).map(({ i }) => ({ i, text: "번역" }));
    return new Response(`data: ${JSON.stringify({ type: "response.output_text.done", text: JSON.stringify({ lines }) })}\n\n`);
  },
});
const gatewayUrl = `http://127.0.0.1:${gateway.port}/v1`;

const call = (path: string, init: RequestInit = {}, headers: Record<string, string> = { origin: SPOTIFY_ORIGIN, "x-slt-token": token }) =>
  fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...headers } });
const save = (body: unknown) => call("/settings", { method: "POST", body: JSON.stringify(body) });
const translate = (trackId: string, lines = ["hello there"]) =>
  call("/translate", { method: "POST", body: JSON.stringify({ trackId, lang: "ko", lines }) });
const envText = () => Bun.file(envFile).text();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "slt-daemon-"));
  envFile = join(dir, ".env");
  await writeFile(envFile, ENV_START, { mode: 0o644 });
  token = await loadToken(dir);
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  base = `http://127.0.0.1:${port}`;
  daemon = Bun.spawn([process.execPath, join(ROOT, "src/daemon.ts")], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SLT_DATA_DIR: dir,
      SLT_ENV_FILE: envFile,
      SLT_PORT: String(port),
      SLT_AUTO_UPDATE: "0",
      SLT_TRANSLATOR: "codex",
      CODEX_GATEWAY_BASE_URL: "http://127.0.0.1:1/v1",
      CODEX_GATEWAY_API_KEY: "old-secret-key",
      SPOTIFY_APP: join(dir, "none.app"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(base).catch(() => null)) return;
    await Bun.sleep(100);
  }
  throw new Error("daemon did not start");
});

afterAll(async () => {
  daemon.kill(9);
  gateway.stop(true);
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  gatewayStatus = 200;
});

test("requests need the Spotify origin and the install token", async () => {
  expect((await call("/settings", {}, {})).status).toBe(403);
  expect((await call("/settings", {}, { origin: "https://evil.example", "x-slt-token": token })).status).toBe(403);
  expect((await call("/settings", {}, { origin: SPOTIFY_ORIGIN })).status).toBe(401);
  expect((await call("/settings", {}, { origin: SPOTIFY_ORIGIN, "x-slt-token": "x".repeat(64) })).status).toBe(401);
  expect((await call("/settings")).status).toBe(200);
});

test("the preflight allows the token header", async () => {
  const res = await fetch(`${base}/settings`, { method: "OPTIONS", headers: { origin: SPOTIFY_ORIGIN } });
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-headers")).toContain("x-slt-token");
});

test("the daemon makes .env private on startup", async () => {
  expect((await stat(envFile)).mode & 0o777).toBe(0o600);
});

test("reading settings never returns the key", async () => {
  const text = await (await call("/settings")).text();
  expect(text).not.toContain("old-secret-key");
  const body = JSON.parse(text);
  expect(body.translator).toBe("codex");
  expect(body.translators.map(({ id }: { id: string }) => id)).toEqual(["codex", "openrouter", "claude", "openai"]);
  expect(body.translators[0]).toEqual({ id: "codex", label: "Codex Gateway", apiUrl: "http://127.0.0.1:1/v1", hasKey: true, plainHttp: false });
});

test("bad input is refused and leaves .env untouched", async () => {
  const bad: [unknown, string][] = [
    [{ apiUrl: "ftp://example.com" }, "invalid_url"],
    [{ apiUrl: "not a url" }, "invalid_url"],
    [{ apiUrl: "https://user:pw@example.com/v1" }, "invalid_url"],
    [{ apiUrl: "https://example.com/v1?x=1" }, "invalid_url"],
    [{ apiUrl: "http://127.0.0.1:1/v1", apiKey: "good\nSLT_UPDATE_REPO=evil/repo" }, "invalid_key"],
    [{ apiUrl: "http://127.0.0.1:1/v1", apiKey: "$(whoami)" }, "invalid_key"],
    [null, "invalid_url"],
  ];
  for (const [body, error] of bad) {
    const res = await save(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  }
  expect(await envText()).toBe(ENV_START);
});

test("moving to another server requires the key again, so the old key is never sent there", async () => {
  const res = await save({ apiUrl: "https://attacker.example/v1" });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "key_required" });
  expect(await envText()).toBe(ENV_START);
});

test("saving updates .env, keeps other lines, and applies without a restart", async () => {
  const res = await save({ apiUrl: `${gatewayUrl}/`, apiKey: "new-secret-key" });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain("new-secret-key");
  expect(JSON.parse(text).translators[0]).toMatchObject({ apiUrl: gatewayUrl, hasKey: true });

  const saved = await envText();
  expect(saved).toContain("# my comment\nSLT_EFFORT=low\n");
  expect(saved).toContain(`CODEX_GATEWAY_BASE_URL=${gatewayUrl}\n`);
  expect(saved).toContain("CODEX_GATEWAY_API_KEY=new-secret-key\n");
  expect(saved).not.toContain("old-secret-key");
  expect((await stat(envFile)).mode & 0o777).toBe(0o600);

  const translated = await translate("1".repeat(22));
  expect(await translated.json()).toEqual({ translations: ["번역"] });
  expect(seen).toEqual([{ auth: "Bearer new-secret-key", host: `127.0.0.1:${gateway.port}` }]);
});

test("a path change on the same server keeps the key", async () => {
  expect((await save({ apiUrl: gatewayUrl })).status).toBe(200);
  expect(await envText()).toContain("CODEX_GATEWAY_API_KEY=new-secret-key\n");
});

test("the translator can be switched and switched back without a restart", async () => {
  expect((await save({ translator: "openai", apiUrl: gatewayUrl, apiKey: "openai-key" })).status).toBe(200);
  const saved = await envText();
  expect(saved).toContain("SLT_TRANSLATOR=openai\n");
  expect(saved).toContain(`OPENAI_BASE_URL=${gatewayUrl}\n`);
  expect(saved).toContain("CODEX_GATEWAY_API_KEY=new-secret-key\n");
  expect(await (await translate("3".repeat(22))).json()).toEqual({ translations: ["번역"] });
  expect(seen.at(-1)?.auth).toBe("Bearer openai-key");

  const body = (await (await save({ translator: "codex", apiUrl: gatewayUrl })).json()) as { translator: string };
  expect(body.translator).toBe("codex");
  expect(await (await translate("4".repeat(22))).json()).toEqual({ translations: ["번역"] });
  expect(seen.at(-1)?.auth).toBe("Bearer new-secret-key");
});

test("an unknown translator is refused", async () => {
  const before = await envText();
  const res = await save({ translator: "constructor", apiUrl: gatewayUrl, apiKey: "k" });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid_translator" });
  expect(await envText()).toBe(before);
});

test("the connection test uses the typed values, saves nothing, and reports the outcome", async () => {
  const before = await envText();
  const check = async () =>
    (await (await call("/settings/test", { method: "POST", body: JSON.stringify({ translator: "openai", apiUrl: gatewayUrl, apiKey: "typed-key" }) })).json()) as { ok: boolean; provider?: string; ms?: number; failure?: string };

  const passed = await check();
  expect(passed).toMatchObject({ ok: true });
  expect(passed.provider).toStartWith("openai:");
  expect(passed.ms).toBeGreaterThanOrEqual(0);
  expect(seen).toEqual([{ auth: "Bearer typed-key", host: `127.0.0.1:${gateway.port}` }]);

  gatewayStatus = 401;
  expect(await check()).toEqual({ ok: false, failure: "rejected" });
  expect(await envText()).toBe(before);
  expect(((await (await call("/settings")).json()) as { translator: string }).translator).toBe("codex");
});

test("the connection test never sends a saved key to another server", async () => {
  const res = await call("/settings/test", { method: "POST", body: JSON.stringify({ translator: "codex", apiUrl: "http://127.0.0.1:2/v1" }) });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "key_required" });
  expect(seen).toHaveLength(0);
});

test("the connection test needs the install token", async () => {
  const res = await call("/settings/test", { method: "POST", body: "{}" }, { origin: SPOTIFY_ORIGIN });
  expect(res.status).toBe(401);
});

test("a rejected key tells the extension not to retry", async () => {
  gatewayStatus = 401;
  const res = await translate("2".repeat(22));
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "translation failed", retry: false });
  expect(seen).toHaveLength(1);
});
