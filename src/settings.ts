import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONNECTIONS, translatorId, type Provider } from "./translator";

type Env = Record<string, string | undefined>;
export type SaveError = "invalid_translator" | "invalid_url" | "invalid_key" | "key_required" | "key_missing";

const TEST_LINE = "The quiet river keeps on running.";
const TEST_TIMEOUT_MS = 30_000;

const SAFE_URL = /^[A-Za-z0-9._~+/=:%[\]-]{1,2048}$/;
const SAFE_KEY = /^[A-Za-z0-9._~+/=:-]{1,1024}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const parseUrl = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export function normalizeApiUrl(value: unknown) {
  const url = typeof value === "string" ? parseUrl(value.trim()) : null;
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  const href = url.href.replace(/\/+$/, "");
  return SAFE_URL.test(href) ? href : null;
}

export function usesPlainHttp(value: string) {
  const url = parseUrl(value);
  return url?.protocol === "http:" && !LOOPBACK.has(url.hostname);
}

export function readSettings(env: Env) {
  const translators = Object.entries(CONNECTIONS).map(([id, { label, urlVar, keyVar, defaultUrl }]) => {
    const apiUrl = env[urlVar] || defaultUrl;
    return { id, label, apiUrl, hasKey: Boolean(env[keyVar]), plainHttp: usesPlainHttp(apiUrl) };
  });
  return { translator: translatorId(env), translators };
}

export function activeUsesPlainHttp(env: Env) {
  const connection = CONNECTIONS[translatorId(env)];
  return Boolean(connection) && usesPlainHttp(env[connection.urlVar] || connection.defaultUrl);
}

export async function updateEnvFile(path: string, updates: Record<string, string>) {
  let text = await Bun.file(path).text().catch(() => "");
  for (const [name, value] of Object.entries(updates)) {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, "gm");
    text = text.search(pattern) >= 0 ? text.replace(pattern, () => line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
  }
  const staging = join(dirname(path), ".env.tmp");
  await writeFile(staging, text, { mode: 0o600 });
  await rename(staging, path);
}

export function resolveSettings(input: unknown, env: Env): SaveError | Record<string, string> {
  const fields = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const translator = fields.translator ?? translatorId(env);
  if (typeof translator !== "string" || !Object.hasOwn(CONNECTIONS, translator)) return "invalid_translator";
  const { urlVar, keyVar, defaultUrl } = CONNECTIONS[translator];

  const url = normalizeApiUrl(fields.apiUrl);
  if (!url) return "invalid_url";
  const key = typeof fields.apiKey === "string" ? fields.apiKey.trim() : "";
  if (key && !SAFE_KEY.test(key)) return "invalid_key";
  if (!key && !env[keyVar]) return "key_missing";
  if (!key && parseUrl(env[urlVar] || defaultUrl)?.origin !== parseUrl(url)?.origin) return "key_required";

  return { SLT_TRANSLATOR: translator, [urlVar]: url, ...(key ? { [keyVar]: key } : {}) };
}

export async function saveSettings(input: unknown, env: Env, envFile: string): Promise<SaveError | null> {
  const updates = resolveSettings(input, env);
  if (typeof updates === "string") return updates;
  await updateEnvFile(envFile, updates);
  Object.assign(env, updates);
  return null;
}

export async function runConnectionTest(provider: Provider, signal: AbortSignal) {
  const lines = await provider.translate("ko", [{ i: 0, text: TEST_LINE }], {
    signal: AbortSignal.any([signal, AbortSignal.timeout(TEST_TIMEOUT_MS)]),
  });
  if (!lines.some(({ text }) => text.trim())) throw new Error("the provider returned an empty answer");
}
