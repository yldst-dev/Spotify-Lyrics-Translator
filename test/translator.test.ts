import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "slt-tr-"));
process.env.SLT_DATA_DIR = dir;
const { createTranslator, isTranslatable } = await import("../src/translator");
const asProvider = (translate: (lang: string, items: { i: number; text: string }[]) => Promise<{ i: number; text: string }[]>) => ({ id: "test", translate });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TRACK = "0123456789abcdefghijkl";

test("isTranslatable skips lines without letters and Korean lines", () => {
  expect(isTranslatable("♪", "ko")).toBe(false);
  expect(isTranslatable("", "ko")).toBe(false);
  expect(isTranslatable("오늘도 걷는다", "ko")).toBe(false);
  expect(isTranslatable("walking on today", "ko")).toBe(true);
  expect(isTranslatable("오늘도 걷는다", "en")).toBe(true);
});

test("translate aligns results to lines, skips untranslatable ones, and caches", async () => {
  const provider = mock(async (_lang: string, items: { i: number; text: string }[]) =>
    items.map(({ i, text }) => ({ i, text: `T:${text}` })),
  );
  const translate = createTranslator(asProvider(provider), join(dir, "a.sqlite"));
  const lines = ["paper boats  at dawn", "♪", "", "종이배", "the river keeps them"];

  const first = await translate(TRACK, "ko", lines);
  expect(first).toEqual(["T:paper boats at dawn", null, null, null, "T:the river keeps them"]);
  expect(provider).toHaveBeenCalledTimes(1);

  expect(await translate(TRACK, "ko", lines)).toEqual(first);
  expect(provider).toHaveBeenCalledTimes(1);
});

test("missing indexes from the provider become null and concurrent calls share one request", async () => {
  const provider = mock(async (_lang: string, items: { i: number; text: string }[]) => [{ i: items[0].i, text: " x " }]);
  const translate = createTranslator(asProvider(provider), join(dir, "b.sqlite"));
  const lines = ["one small light", "two small lights"];

  const [a, b] = await Promise.all([translate(TRACK, "ko", lines), translate(TRACK, "ko", lines)]);
  expect(a).toEqual(["x", null]);
  expect(b).toEqual(a);
  expect(provider).toHaveBeenCalledTimes(1);
});

test("provider failures are not cached", async () => {
  let fail = true;
  const provider = mock(async (_lang: string, items: { i: number; text: string }[]) => {
    if (fail) throw new Error("boom");
    return items.map(({ i }) => ({ i, text: "ok" }));
  });
  const translate = createTranslator(asProvider(provider), join(dir, "c.sqlite"));
  await expect(translate(TRACK, "ko", ["hello there"])).rejects.toThrow("boom");
  fail = false;
  expect(await translate(TRACK, "ko", ["hello there"])).toEqual(["ok"]);
});

const slowProvider = () => {
  const seen: AbortSignal[] = [];
  const provider = asProvider(async (_lang, items) => {
    throw new Error(`unused ${items.length}`);
  });
  provider.translate = ((_lang: string, items: { i: number; text: string }[], signal?: AbortSignal) => {
    if (signal) seen.push(signal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(items.map(({ i }) => ({ i, text: "done" }))), 300);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      });
    });
  }) as typeof provider.translate;
  return { provider, seen };
};

test("the only waiter cancelling aborts the upstream call and nothing is cached", async () => {
  const { provider, seen } = slowProvider();
  const translate = createTranslator(provider, join(dir, "d.sqlite"));
  const controller = new AbortController();
  const pending = translate(TRACK, "ko", ["a paper lantern"], controller.signal);
  await Bun.sleep(20);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(seen[0].aborted).toBe(true);
  expect(await translate(TRACK, "ko", ["a paper lantern"])).toEqual(["done"]);
});

test("upstream keeps running while another waiter still wants it", async () => {
  const { provider, seen } = slowProvider();
  const translate = createTranslator(provider, join(dir, "e.sqlite"));
  const leaving = new AbortController();
  const first = translate(TRACK, "ko", ["the tide comes back"], leaving.signal);
  const second = translate(TRACK, "ko", ["the tide comes back"]);
  await Bun.sleep(20);
  leaving.abort();
  await expect(first).rejects.toThrow();
  expect(await second).toEqual(["done"]);
  expect(seen).toHaveLength(1);
  expect(seen[0].aborted).toBe(false);
});
