import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config";

const PROMPT_VERSION = 3;
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 3;

const LANGUAGE_NAMES: Record<string, string> = {
  ko: "Korean",
  en: "English",
  ja: "Japanese",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  es: "Spanish",
  fr: "French",
  de: "German",
};

export const isSupportedLanguage = (lang: string) => lang in LANGUAGE_NAMES;

const SYSTEM = `You translate song lyrics for display directly under each original line in a music player.
Translate each line so it reads naturally as lyrics in the target language, keeping tone, imagery, and wordplay rather than translating word for word.
Read the whole song first and keep repeated lines and recurring phrases consistent.
Songs often mix languages, such as Japanese, Chinese, Korean, and English, both across lines and inside a single line. Translate every line and every part of a line that is not in the target language. Do not leave English or any other language untranslated because it looks like a hook, a chorus, or a stylistic choice. When a line mixes languages, return the whole line fully in the target language.
Keep only proper nouns and pure vocalizations such as "oh" or "la la" as they are.
Return exactly one entry for every input index. Return an empty string only when the entire line is already in the target language, or is only a vocalization or a symbol.
If the request has a "retranslate" list, an earlier attempt left those lines untranslated or partly untranslated. Translate those lines fully into the target language, using the other lines only as context, and return entries for those indexes only.`;

const JSON_RULE = `Respond with only a JSON object of the form {"lines":[{"i":0,"text":"..."}]}, with no Markdown fences and no other text.`;

const SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "integer" }, text: { type: "string" } },
        required: ["i", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
};

export type Item = { i: number; text: string };
export type TranslateOptions = { signal?: AbortSignal; focus?: number[] };
export type Provider = { id: string; translate: (lang: string, items: Item[], options?: TranslateOptions) => Promise<Item[]> };
type SseEvent = { type?: string; [key: string]: unknown };

class RetryableError extends Error {}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

const requestSignal = (signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

const isAbort = (error: unknown) => error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");

const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });

const userContent = (lang: string, items: Item[], focus?: number[]) =>
  JSON.stringify({ target_language: LANGUAGE_NAMES[lang], lines: items, ...(focus?.length ? { retranslate: focus } : {}) });

const HANGUL = /\p{Script=Hangul}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;
const VOCALIZATION = /^(?:o+h+|a+h+|la|na|ye+a+h?|hey|wo+|whoa|uh|m+|hmm|ha|da|doo|ya|yo)+$/;

const lettersOf = (text: string) => text.match(/\p{L}/gu) ?? [];

const isTargetScript = (char: string, lang: string): boolean | null => {
  if (lang === "ko") return HANGUL.test(char);
  if (lang === "ja") return KANA.test(char) || HAN.test(char);
  if (lang === "zh-CN" || lang === "zh-TW") return HAN.test(char);
  return null;
};

const foreignLetterCount = (text: string, lang: string) => {
  const letters = lettersOf(text);
  if (lang === "ja" && !letters.some((char) => KANA.test(char))) return letters.filter((char) => !KANA.test(char)).length;
  return letters.filter((char) => isTargetScript(char, lang) === false).length;
};

const isVocalization = (text: string) => VOCALIZATION.test(lettersOf(text).join("").toLowerCase());

export function isTranslatable(text: string, lang: string) {
  const letters = lettersOf(text);
  if (!letters.length) return false;
  if (isTargetScript(letters[0], lang) === null) return true;
  return foreignLetterCount(text, lang) > 0;
}

export function needsRetranslation(source: string, translation: string | undefined, lang: string) {
  if (isTargetScript("a", lang) === null || isVocalization(source) || foreignLetterCount(source, lang) < 3) return false;
  if (!translation || normalize(translation) === normalize(source)) return true;
  return !lettersOf(translation).some((char) => isTargetScript(char, lang));
}

export function parseLines(text: string): Item[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new RetryableError("response has no JSON object");
  let lines: unknown;
  try {
    lines = (JSON.parse(text.slice(start, end + 1)) as { lines?: unknown }).lines;
  } catch {
    throw new RetryableError("response JSON is invalid");
  }
  if (!Array.isArray(lines)) throw new RetryableError("response JSON has no lines array");
  return lines.filter((line): line is Item => Number.isInteger(line?.i) && typeof line?.text === "string");
}

const parseSseBlock = (block: string): SseEvent | null => {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data && data !== "[DONE]" ? (JSON.parse(data) as SseEvent) : null;
};

export async function* readSse(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const event = parseSseBlock(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (event) yield event;
    }
  }
  const last = parseSseBlock(buffer.trim());
  if (last) yield last;
}

async function withRetry<T>(work: () => Promise<T>, delayMs: number, signal?: AbortSignal) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof RetryableError) || attempt >= MAX_ATTEMPTS) throw error;
      await Bun.sleep(delayMs * attempt);
      signal?.throwIfAborted();
    }
  }
}

export const CODEX_SERVICE_TIERS = ["priority", "default"] as const;
export type CodexServiceTier = (typeof CODEX_SERVICE_TIERS)[number];

export function createCodexProvider(options: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  effort: string;
  serviceTier?: CodexServiceTier;
  retryDelayMs?: number;
}): Provider {
  const { baseUrl, apiKey, model, effort, serviceTier = "priority", retryDelayMs = 2000 } = options;

  async function once(lang: string, items: Item[], { signal, focus }: TranslateOptions) {
    if (!apiKey) throw new Error("CODEX_GATEWAY_API_KEY is not set");
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/+$/, "")}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          instructions: `${SYSTEM}\n${JSON_RULE}`,
          input: [{ role: "user", content: userContent(lang, items, focus) }],
          store: false,
          stream: true,
          reasoning: { effort },
          ...(serviceTier === "priority" ? { service_tier: "priority" } : {}),
        }),
        signal: requestSignal(signal),
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new RetryableError(`gateway unreachable: ${String(error)}`);
    }
    if (!res.ok || !res.body) {
      const detail = `codex gateway ${res.status}: ${(await res.text()).slice(0, 300)}`;
      throw res.status === 502 ? new RetryableError(detail) : new Error(detail);
    }

    let deltas = "";
    let done: string | null = null;
    for await (const event of readSse(res.body)) {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") deltas += event.delta;
      else if (event.type === "response.output_text.done" && typeof event.text === "string") done = event.text;
      else if (event.type === "response.failed" || event.type === "error")
        throw new Error(`codex ${event.type}: ${JSON.stringify(event).slice(0, 300)}`);
    }
    return parseLines(done ?? deltas);
  }

  return {
    id: `codex:${model}:${effort}`,
    translate: (lang, items, options = {}) => withRetry(() => once(lang, items, options), retryDelayMs, options.signal),
  };
}

export function createOpenRouterProvider(options: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  effort: string;
  retryDelayMs?: number;
}): Provider {
  const { baseUrl, apiKey, model, effort, retryDelayMs = 2000 } = options;

  async function once(lang: string, items: Item[], { signal, focus }: TranslateOptions) {
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-title": "Spotify Lyrics Translator",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: userContent(lang, items, focus) },
          ],
          response_format: { type: "json_schema", json_schema: { name: "lyrics_translation", strict: true, schema: SCHEMA } },
          provider: { require_parameters: true },
          reasoning: { effort, exclude: true },
        }),
        signal: requestSignal(signal),
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new RetryableError(`openrouter unreachable: ${String(error)}`);
    }

    const raw = await res.text();
    const detail = `openrouter ${res.status}: ${raw.slice(0, 300)}`;
    if (res.status === 429 || res.status >= 500) throw new RetryableError(detail);
    if (!res.ok) throw new Error(detail);

    const body = JSON.parse(raw) as {
      error?: { code?: number; message?: string };
      choices?: { finish_reason?: string; message?: { content?: string | null } }[];
    };
    if (body.error) {
      const code = body.error.code ?? 0;
      throw code === 429 || code >= 500 ? new RetryableError(detail) : new Error(detail);
    }
    const choice = body.choices?.[0];
    if (choice?.finish_reason === "length") throw new Error("openrouter answer was cut off");
    return parseLines(choice?.message?.content ?? "");
  }

  return {
    id: `openrouter:${model}:${effort}`,
    translate: (lang, items, options = {}) => withRetry(() => once(lang, items, options), retryDelayMs, options.signal),
  };
}

export function createClaudeProvider(options: { apiKey?: string; model: string; effort: string }): Provider {
  const { apiKey, model, effort } = options;
  return {
    id: `claude:${model}:${effort}`,
    async translate(lang, items, { signal, focus } = {}) {
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "server-side-fallback-2026-07-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 16000,
          fallbacks: "default",
          output_config: { effort, format: { type: "json_schema", schema: SCHEMA } },
          system: SYSTEM,
          messages: [{ role: "user", content: userContent(lang, items, focus) }],
        }),
        signal: requestSignal(signal),
      });
      if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const message = (await res.json()) as { stop_reason: string; content: { type: string; text?: string }[] };
      if (message.stop_reason !== "end_turn") throw new Error(`Claude stopped with ${message.stop_reason}`);
      return parseLines(message.content.find((block) => block.type === "text")?.text ?? "");
    },
  };
}

export const mockProvider: Provider = {
  id: "mock",
  translate: async (_lang, items, { focus } = {}) =>
    items.filter(({ i }) => !focus || focus.includes(i)).map(({ i }) => ({ i, text: `〔${i + 1}〕` })),
};

export function providerFromEnv(env = process.env): Provider {
  const effort = env.SLT_EFFORT ?? "medium";
  switch (env.SLT_TRANSLATOR ?? "codex") {
    case "codex": {
      const serviceTier = env.CODEX_SERVICE_TIER ?? "priority";
      if (!CODEX_SERVICE_TIERS.includes(serviceTier as CodexServiceTier))
        throw new Error(`CODEX_SERVICE_TIER must be one of ${CODEX_SERVICE_TIERS.join(", ")}: ${serviceTier}`);
      return createCodexProvider({
        baseUrl: env.CODEX_GATEWAY_BASE_URL ?? "http://192.168.0.9:8080/v1",
        apiKey: env.CODEX_GATEWAY_API_KEY,
        model: env.CODEX_MODEL ?? "gpt-6-astra",
        effort,
        serviceTier: serviceTier as CodexServiceTier,
      });
    }
    case "openrouter":
      return createOpenRouterProvider({
        baseUrl: env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL ?? "openai/gpt-6-luna",
        effort,
      });
    case "claude":
      return createClaudeProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.SLT_MODEL ?? "claude-opus-5", effort });
    case "mock":
      return mockProvider;
    default:
      throw new Error(`unknown SLT_TRANSLATOR: ${env.SLT_TRANSLATOR}`);
  }
}

export function createTranslator(provider: Provider = providerFromEnv(), dbPath = join(DATA_DIR, "cache.sqlite")) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run("CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, lines TEXT NOT NULL, created INTEGER NOT NULL)");
  const read = db.query<{ lines: string }, [string]>("SELECT lines FROM translations WHERE key = ?");
  const write = db.query("INSERT OR REPLACE INTO translations (key, lines, created) VALUES (?, ?, ?)");
  const jobs = new Map<string, { promise: Promise<(string | null)[]>; controller: AbortController; waiters: number }>();

  const keyOf = (trackId: string, lang: string, lines: string[]) =>
    [PROMPT_VERSION, provider.id, lang, trackId, Bun.hash(lines.join("\n")).toString(16)].join(":");

  async function run(key: string, lang: string, lines: string[], signal: AbortSignal) {
    const items = lines.map((text, i) => ({ i, text: normalize(text) })).filter(({ text }) => isTranslatable(text, lang));
    const sources = new Map(items.map(({ i, text }) => [i, text]));
    const byIndex = new Map<number, string>();
    const accept = (entries: Item[], focus?: Set<number>) => {
      for (const { i, text } of entries) {
        const source = sources.get(i);
        if (source === undefined || (focus && !focus.has(i)) || !text.trim()) continue;
        if (focus && needsRetranslation(source, text, lang) && byIndex.has(i)) continue;
        byIndex.set(i, text.trim());
      }
    };

    if (items.length) {
      accept(await provider.translate(lang, items, { signal }));
      const focus = items.filter(({ i, text }) => needsRetranslation(text, byIndex.get(i), lang)).map(({ i }) => i);
      if (focus.length) {
        try {
          accept(await provider.translate(lang, items, { signal, focus }), new Set(focus));
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
    }
    const result = lines.map((_, i) => {
      const translation = byIndex.get(i);
      return translation && translation !== sources.get(i) ? translation : null;
    });
    write.run(key, JSON.stringify(result), Date.now());
    return result;
  }

  return async function translate(trackId: string, lang: string, lines: string[], signal?: AbortSignal) {
    const key = keyOf(trackId, lang, lines);
    const cached = read.get(key);
    if (cached) return JSON.parse(cached.lines) as (string | null)[];

    let job = jobs.get(key);
    if (!job) {
      const controller = new AbortController();
      const promise = run(key, lang, lines, controller.signal).finally(() => jobs.delete(key));
      promise.catch(() => {});
      job = { promise, controller, waiters: 0 };
      jobs.set(key, job);
    }

    const current = job;
    current.waiters++;
    try {
      return await (signal ? raceAbort(current.promise, signal) : current.promise);
    } finally {
      current.waiters--;
      if (current.waiters === 0 && signal?.aborted) current.controller.abort();
    }
  };
}
