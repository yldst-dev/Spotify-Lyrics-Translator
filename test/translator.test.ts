import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "slt-tr-"));
process.env.SLT_DATA_DIR = dir;
const { createTranslator, isTranslatable, needsRetranslation } = await import("../src/translator");
const asProvider = (translate: (lang: string, items: { i: number; text: string }[]) => Promise<{ i: number; text: string }[]>) => ({ id: "test", translate });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TRACK = "0123456789abcdefghijkl";

test("isTranslatable skips lines without letters and Korean lines", () => {
  expect(isTranslatable("♪", "ko")).toBe(false);
  expect(isTranslatable("", "ko")).toBe(false);
  expect(isTranslatable("오늘도 걷는다", "ko")).toBe(false);
  expect(isTranslatable("오늘도 walking alone", "ko")).toBe(true);
  expect(isTranslatable("夜の駅で待ってる", "ko")).toBe(true);
  expect(isTranslatable("walking on today", "ko")).toBe(true);
  expect(isTranslatable("오늘도 걷는다", "en")).toBe(true);
});

test("translate aligns results to lines, skips untranslatable ones, and caches", async () => {
  const provider = mock(async (_lang: string, items: { i: number; text: string }[]) =>
    items.map(({ i, text }) => ({ i, text: `번역 ${text}` })),
  );
  const translate = createTranslator(asProvider(provider), join(dir, "a.sqlite"));
  const lines = ["paper boats  at dawn", "♪", "", "종이배", "the river keeps them"];

  const first = await translate(TRACK, "ko", lines);
  expect(first).toEqual(["번역 paper boats at dawn", null, null, null, "번역 the river keeps them"]);
  expect(provider).toHaveBeenCalledTimes(1);

  expect(await translate(TRACK, "ko", lines)).toEqual(first);
  expect(provider).toHaveBeenCalledTimes(1);
});

test("missing indexes from the provider become null and concurrent calls share one request", async () => {
  const provider = mock(async (_lang: string, items: { i: number; text: string }[]) => [{ i: items[0].i, text: " 불빛 하나 " }]);
  const translate = createTranslator(asProvider(provider), join(dir, "b.sqlite"));
  const lines = ["one small light", "two small lights"];

  const [a, b] = await Promise.all([translate(TRACK, "ko", lines), translate(TRACK, "ko", lines)]);
  expect(a).toEqual(["불빛 하나", null]);
  expect(b).toEqual(a);
  expect(provider).toHaveBeenCalledTimes(2);
});

test("provider failures are not cached", async () => {
  let fail = true;
  const provider = mock(async (_lang: string, items: { i: number; text: string }[]) => {
    if (fail) throw new Error("boom");
    return items.map(({ i }) => ({ i, text: "안녕" }));
  });
  const translate = createTranslator(asProvider(provider), join(dir, "c.sqlite"));
  await expect(translate(TRACK, "ko", ["hello there"])).rejects.toThrow("boom");
  fail = false;
  expect(await translate(TRACK, "ko", ["hello there"])).toEqual(["안녕"]);
});

const slowProvider = () => {
  const seen: AbortSignal[] = [];
  const provider = asProvider(async (_lang, items) => {
    throw new Error(`unused ${items.length}`);
  });
  provider.translate = ((_lang: string, items: { i: number; text: string }[], { signal }: { signal?: AbortSignal } = {}) => {
    if (signal) seen.push(signal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(items.map(({ i }) => ({ i, text: "완료" }))), 300);
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
  expect(await translate(TRACK, "ko", ["a paper lantern"])).toEqual(["완료"]);
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
  expect(await second).toEqual(["완료"]);
  expect(seen).toHaveLength(1);
  expect(seen[0].aborted).toBe(false);
});

test("isTranslatable decides by script for Japanese and Chinese targets", () => {
  expect(isTranslatable("夜の駅で待ってる", "ja")).toBe(false);
  expect(isTranslatable("风吹过城市", "ja")).toBe(true);
  expect(isTranslatable("夜の駅で running", "ja")).toBe(true);
  expect(isTranslatable("风吹过城市", "zh-CN")).toBe(false);
  expect(isTranslatable("夜の駅で待ってる", "zh-CN")).toBe(true);
});

test("needsRetranslation flags lines left in another language", () => {
  expect(needsRetranslation("we run until the light", "we run until the light", "ko")).toBe(true);
  expect(needsRetranslation("we run until the light", undefined, "ko")).toBe(true);
  expect(needsRetranslation("夜の駅で待ってる", "夜の駅で待ってる", "ko")).toBe(true);
  expect(needsRetranslation("we run until the light", "빛이 올 때까지 달려", "ko")).toBe(false);
  expect(needsRetranslation("oh oh oh", undefined, "ko")).toBe(false);
  expect(needsRetranslation("OK", undefined, "ko")).toBe(false);
  expect(needsRetranslation("we run", "we run", "en")).toBe(false);
});

test("mixed-language songs get a second pass for the lines left untranslated", async () => {
  const lines = ["夜の駅で待ってる", "we run until the light", "风吹过城市", "oh oh oh", "夜の駅で running away"];
  const calls: { focus?: number[] }[] = [];
  const provider = asProvider(async () => []);
  provider.translate = (async (_lang: string, items: { i: number; text: string }[], options: { focus?: number[] } = {}) => {
    calls.push({ focus: options.focus });
    if (!options.focus)
      return [
        { i: 0, text: "밤의 역에서 기다려" },
        { i: 1, text: "we run until the light" },
        { i: 2, text: "" },
        { i: 3, text: "" },
        { i: 4, text: "밤의 역에서 running away" },
      ];
    return items.filter(({ i }) => options.focus?.includes(i)).map(({ i }) => ({ i, text: `다시 번역 ${i}` }));
  }) as typeof provider.translate;

  const translate = createTranslator(provider, join(dir, "f.sqlite"));
  const result = await translate(TRACK, "ko", lines);

  expect(calls).toHaveLength(2);
  expect(calls[1].focus).toEqual([1, 2]);
  expect(result).toEqual(["밤의 역에서 기다려", "다시 번역 1", "다시 번역 2", null, "밤의 역에서 running away"]);
});

test("a failed second pass keeps the first results", async () => {
  let call = 0;
  const provider = asProvider(async () => []);
  provider.translate = (async (_lang: string, _items: { i: number; text: string }[], options: { focus?: number[] } = {}) => {
    call++;
    if (options.focus) throw new Error("second pass down");
    return [
      { i: 0, text: "밤의 역에서 기다려" },
      { i: 1, text: "we run until the light" },
    ];
  }) as typeof provider.translate;

  const translate = createTranslator(provider, join(dir, "g.sqlite"));
  expect(await translate(TRACK, "ko", ["夜の駅で待ってる", "we run until the light"])).toEqual(["밤의 역에서 기다려", null]);
  expect(call).toBe(2);
});
