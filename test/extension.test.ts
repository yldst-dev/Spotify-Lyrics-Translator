import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const SOURCE = await Bun.file(new URL("../extension/lyrics-translator.js", import.meta.url)).text();
const TRACK_A = "A".repeat(22);
const TRACK_B = "B".repeat(22);
const LYRICS = /color-lyrics/;

type Answer = { status: number; body: unknown };

function boot(answer: (trackId: string) => Answer) {
  const timers: { fn: () => void; ms: number; cancelled?: boolean }[] = [];
  const frames: (() => void)[] = [];
  const posts: { trackId: string; token: string | undefined }[] = [];
  let lines: ReturnType<typeof line>[] = [];

  function line(text: string) {
    let node: { className: string; textContent: string; remove: () => void } | null = null;
    return {
      text,
      translation: () => node?.textContent ?? null,
      firstElementChild: { textContent: text, classList: { contains: () => false } },
      querySelector: () => node,
      append(child: typeof node) {
        node = child;
        if (node) node.remove = () => (node = null);
      },
    };
  }

  const fakeFetch = async (input: string, init: { body?: string; headers?: Record<string, string> } = {}) => {
    if (LYRICS.test(input)) {
      const trackId = input.split("/track/")[1];
      const words = trackId === TRACK_A ? ["shared line", "only in a"] : ["shared line", "only in b"];
      return Response.json({ lyrics: { lines: words.map((w) => ({ words: w })) } });
    }
    const { trackId } = JSON.parse(init.body ?? "{}");
    posts.push({ trackId, token: init.headers?.["x-slt-token"] });
    const { status, body } = answer(trackId);
    return Response.json(body, { status });
  };

  const sandbox: Record<string, unknown> = {
    window: { fetch: fakeFetch },
    document: {
      currentScript: { dataset: { sltToken: "the-token" } },
      createElement: () => ({ append() {}, classList: { contains: () => false } }),
      head: { append() {} },
      documentElement: { setAttribute() {}, toggleAttribute() {} },
      body: {},
      querySelector: () => null,
      querySelectorAll: () => lines,
      addEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    MutationObserver: class {
      observe() {}
    },
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    clearTimeout: (id: number) => {
      if (timers[id - 1]) timers[id - 1].cancelled = true;
    },
    AbortController,
    Request,
  };
  runInNewContext(SOURCE, sandbox);
  const page = sandbox.window as { fetch: (url: string) => Promise<Response> };

  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      for (const frame of frames.splice(0)) frame();
      await Bun.sleep(1);
    }
  };
  const fireShort = () => {
    for (const timer of timers) {
      if (!timer.cancelled && timer.ms < 1000) {
        timer.cancelled = true;
        timer.fn();
      }
    }
  };
  const open = async (trackId: string) => {
    await page.fetch(`https://spclient/color-lyrics/v2/track/${trackId}`);
    const words = trackId === TRACK_A ? ["shared line", "only in a"] : ["shared line", "only in b"];
    lines = words.map(line);
    await settle();
    fireShort();
    await settle();
    return lines;
  };
  const pendingRetries = () => timers.filter((timer) => !timer.cancelled && timer.ms >= 1000);
  const fireRetry = async () => {
    const [next] = pendingRetries();
    next.cancelled = true;
    next.fn();
    await settle();
  };
  return { open, posts, pendingRetries, fireRetry };
}

const translated = (trackId: string): Answer => ({
  status: 200,
  body: { translations: trackId === TRACK_A ? ["A 번역", "A만"] : ["B 번역", "B만"] },
});

test("two songs sharing a line each show their own translation", async () => {
  const { open } = boot(translated);
  expect((await open(TRACK_A)).map((l) => l.translation())).toEqual(["A 번역", "A만"]);
  expect((await open(TRACK_B)).map((l) => l.translation())).toEqual(["B 번역", "B만"]);
  expect((await open(TRACK_A)).map((l) => l.translation())).toEqual(["A 번역", "A만"]);
});

test("requests carry the install token", async () => {
  const { open, posts } = boot(translated);
  await open(TRACK_A);
  expect(posts).toEqual([{ trackId: TRACK_A, token: "the-token" }]);
});

test("a permanent failure is not retried", async () => {
  const { open, posts, pendingRetries } = boot(() => ({ status: 502, body: { error: "translation failed", retry: false } }));
  await open(TRACK_A);
  expect(posts).toHaveLength(1);
  expect(pendingRetries()).toHaveLength(0);
});

test("a transient failure backs off and then stops", async () => {
  const { open, posts, pendingRetries, fireRetry } = boot(() => ({ status: 502, body: { error: "translation failed", retry: true } }));
  await open(TRACK_A);
  const delays: number[] = [];
  while (pendingRetries().length) {
    delays.push(pendingRetries()[0].ms);
    await fireRetry();
  }
  expect(delays).toEqual([10000, 30000, 120000]);
  expect(posts).toHaveLength(4);
});
