import { timingSafeEqual } from "node:crypto";
import { chmod, stat } from "node:fs/promises";
import { AUTO_UPDATE, DATA_DIR, DEV, DEV_LOADER, ENV_FILE, EXTENSION, PORT, SPOTIFY_ORIGIN } from "./config";
import { hashFile, loadToken, spotify } from "./patcher";
import { activeUsesPlainHttp, readSettings, resolveSettings, runConnectionTest, saveSettings } from "./settings";
import { classifyFailure, createTranslator, isSupportedLanguage, isTransient, providerFromEnv } from "./translator";
import { applyUpdate, currentVersion, isNewer, isSpotifyRunning, latestRelease } from "./updater";

const TRACK_ID = /^[A-Za-z0-9]{22}$/;
const MAX_LINES = 400;
const MAX_LINE_LENGTH = 500;
const WATCH_INTERVAL_MS = 30_000;
const SPOTIFY_POLL_MS = 5_000;
const UPDATE_MIN_INTERVAL_MS = 10 * 60_000;
const SPOTIFY_EVENT_MIN_INTERVAL_MS = 60_000;
const UPDATE_PERIOD_MS = 6 * 60 * 60_000;

const CORS = {
  "access-control-allow-origin": SPOTIFY_ORIGIN,
  "access-control-allow-headers": "content-type, x-slt-token",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-private-network": "true",
  vary: "origin",
};

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

await chmod(ENV_FILE, 0o600).catch(() => {});
const TOKEN = await loadToken(DATA_DIR);

let provider = providerFromEnv();
let translate = createTranslator(provider);

const warnIfPlainHttp = () => {
  if (activeUsesPlainHttp(process.env)) log("warning: the API URL uses plain http, so the API key and lyrics are not encrypted");
};

const hasToken = (req: Request) => {
  const given = Buffer.from(req.headers.get("x-slt-token") ?? "");
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

function parseTranslateBody(body: unknown) {
  if (typeof body !== "object" || body === null) return null;
  const { trackId, lang, lines } = body as Record<string, unknown>;
  if (typeof trackId !== "string" || !TRACK_ID.test(trackId)) return null;
  if (typeof lang !== "string" || !isSupportedLanguage(lang)) return null;
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_LINES) return null;
  if (!lines.every((line) => typeof line === "string" && line.length <= MAX_LINE_LENGTH)) return null;
  return { trackId, lang, lines: lines as string[] };
}

async function handleTranslate(req: Request) {
  const input = parseTranslateBody(await req.json().catch(() => null));
  if (!input) return json({ error: "invalid request" }, 400);
  const started = performance.now();
  try {
    const translations = await translate(input.trackId, input.lang, input.lines, req.signal);
    const filled = translations.filter(Boolean).length;
    log("translated", input.trackId, `${filled}/${translations.length} lines`, `${Math.round(performance.now() - started)}ms`);
    return json({ translations });
  } catch (error) {
    if (req.signal.aborted) {
      log("cancelled", input.trackId, `${Math.round(performance.now() - started)}ms`);
      return json({ error: "cancelled" }, 499);
    }
    log("translate failed", input.trackId, String(error));
    return json({ error: "translation failed", retry: isTransient(error) }, 502);
  }
}

async function handleSettings(req: Request) {
  if (req.method === "POST") {
    const result = await saveSettings(await req.json().catch(() => null), process.env, ENV_FILE);
    if (result) return json({ error: result }, 400);
    provider = providerFromEnv();
    translate = createTranslator(provider);
    log("settings updated", provider.id);
    warnIfPlainHttp();
  }
  return json(readSettings(process.env));
}

async function handleConnectionTest(req: Request) {
  const updates = resolveSettings(await req.json().catch(() => null), process.env);
  if (typeof updates === "string") return json({ error: updates }, 400);
  const tester = providerFromEnv({ ...process.env, ...updates });
  const started = performance.now();
  try {
    await runConnectionTest(tester, req.signal);
    const ms = Math.round(performance.now() - started);
    log("connection test passed", tester.id, `${ms}ms`);
    return json({ ok: true, provider: tester.id, ms });
  } catch (error) {
    log("connection test failed", tester.id, String(error));
    return json({ ok: false, failure: classifyFailure(error) });
  }
}

async function handleDev(req: Request, pathname: string) {
  if (pathname === "/dev/version") return new Response(String((await stat(EXTENSION)).mtimeMs), { headers: CORS });
  if (pathname === "/dev/extension.js")
    return new Response(Bun.file(EXTENSION), { headers: { ...CORS, "content-type": "text/javascript" } });
  if (pathname === "/dev/log" && req.method === "POST") {
    log("dev", await req.text());
    return new Response(null, { status: 204, headers: CORS });
  }
  return new Response("not found", { status: 404, headers: CORS });
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    if (req.headers.get("origin") !== SPOTIFY_ORIGIN) return new Response("forbidden", { status: 403 });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const { pathname } = new URL(req.url);
    if (DEV && pathname.startsWith("/dev/")) return handleDev(req, pathname);
    if (!hasToken(req)) return json({ error: "unauthorized" }, 401);
    if (req.method === "POST" && pathname === "/translate") return handleTranslate(req);
    if ((req.method === "GET" || req.method === "POST") && pathname === "/settings") return handleSettings(req);
    if (req.method === "POST" && pathname === "/settings/test") return handleConnectionTest(req);
    return new Response("not found", { status: 404, headers: CORS });
  },
});

let lastSeen = "";

async function ensurePatched() {
  const script = DEV ? DEV_LOADER : EXTENSION;
  try {
    const hash = await hashFile(script, TOKEN);
    const signature = async () => {
      const spa = await stat(spotify.spa);
      return `${spa.mtimeMs}:${spa.size}:${hash}`;
    };
    if ((await signature()) === lastSeen) return;
    const state = await spotify.patchState();
    if (state.patchedHash !== hash) {
      await spotify.apply(script);
      log(`patched Spotify ${state.version} with ${DEV ? "dev loader" : "extension"} ${hash}`);
    }
    lastSeen = await signature();
  } catch (error) {
    log("patch check failed", String(error));
  }
}

let lastUpdateCheck = 0;
let updating = false;

async function checkForUpdate(reason: string, minIntervalMs = UPDATE_MIN_INTERVAL_MS) {
  if (DEV || !AUTO_UPDATE || updating || Date.now() - lastUpdateCheck < minIntervalMs) return;
  lastUpdateCheck = Date.now();
  updating = true;
  try {
    const [current, latest] = await Promise.all([currentVersion(), latestRelease()]);
    if (!latest || !isNewer(latest, current)) {
      log(`update check on ${reason}: v${current} is up to date`);
      return;
    }
    const result = await applyUpdate(latest);
    if (result.status === "skipped") {
      log(`update to ${latest} skipped on ${reason}: ${result.reason}`);
      return;
    }
    log(`updated ${current} to ${result.to} on ${reason}, restarting`);
    setTimeout(() => process.exit(0), 200);
  } catch (error) {
    log("update check failed", String(error));
  } finally {
    updating = false;
  }
}

let spotifyRunning = await isSpotifyRunning();

async function watchSpotify() {
  const running = await isSpotifyRunning();
  if (running === spotifyRunning) return;
  spotifyRunning = running;
  await checkForUpdate(running ? "spotify start" : "spotify quit", SPOTIFY_EVENT_MIN_INTERVAL_MS);
}

warnIfPlainHttp();
await ensurePatched();
setInterval(ensurePatched, WATCH_INTERVAL_MS);
setInterval(watchSpotify, SPOTIFY_POLL_MS);
setInterval(() => checkForUpdate("schedule"), UPDATE_PERIOD_MS);
setTimeout(() => checkForUpdate("startup"), 10_000);
log(
  `v${await currentVersion()} listening on 127.0.0.1:${PORT} with ${provider.id}${DEV ? " (dev)" : ""}${AUTO_UPDATE && !DEV ? "" : " (auto update off)"}`,
);
