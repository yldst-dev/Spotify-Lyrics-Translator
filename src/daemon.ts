import { stat } from "node:fs/promises";
import { DEV, DEV_LOADER, EXTENSION, PORT, SPOTIFY_ORIGIN } from "./config";
import { hashFile, spotify } from "./patcher";
import { createTranslator, isSupportedLanguage, providerFromEnv } from "./translator";

const TRACK_ID = /^[A-Za-z0-9]{22}$/;
const MAX_LINES = 400;
const MAX_LINE_LENGTH = 500;
const WATCH_INTERVAL_MS = 30_000;

const CORS = {
  "access-control-allow-origin": SPOTIFY_ORIGIN,
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-private-network": "true",
  vary: "origin",
};

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

const provider = providerFromEnv();
const translate = createTranslator(provider);

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
    return json({ error: "translation failed" }, 502);
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
    if (req.method === "POST" && pathname === "/translate") return handleTranslate(req);
    if (DEV && pathname.startsWith("/dev/")) return handleDev(req, pathname);
    return new Response("not found", { status: 404, headers: CORS });
  },
});

let lastSeen = "";

async function ensurePatched() {
  const script = DEV ? DEV_LOADER : EXTENSION;
  try {
    const hash = await hashFile(script);
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

await ensurePatched();
setInterval(ensurePatched, WATCH_INTERVAL_MS);
log(`listening on 127.0.0.1:${PORT} with ${provider.id}${DEV ? " (dev)" : ""}`);
