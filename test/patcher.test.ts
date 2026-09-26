import { $ } from "bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatcher } from "../src/patcher";

const INDEX = '<!doctype html><html><head></head><body><script defer="defer" src="/xpui-snapshot.js"></script></body></html>';

let root: string;
let patcher: ReturnType<typeof createPatcher>;
let spa: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "slt-test-"));
  const app = join(root, "Spotify.app");
  const apps = join(app, "Contents/Resources/Apps");
  await mkdir(apps, { recursive: true });
  await $`plutil -create xml1 ${join(app, "Contents/Info.plist")}`.quiet();
  await $`plutil -insert CFBundleShortVersionString -string 9.9.9 ${join(app, "Contents/Info.plist")}`.quiet();
  const src = join(root, "src");
  await mkdir(src);
  await writeFile(join(src, "index.html"), INDEX);
  await writeFile(join(src, "xpui-snapshot.js"), "void 0;");
  spa = join(apps, "xpui.spa");
  await $`zip -q -X ${spa} index.html xpui-snapshot.js`.cwd(src);
  patcher = createPatcher({ app, dataDir: join(root, "data") });
  if (!patcher.spa.startsWith(root)) throw new Error("test patcher must not point at the real Spotify app");
});

afterAll(() => rm(root, { recursive: true, force: true }));

const index = () => $`unzip -p ${spa} index.html`.quiet().text();

test("apply injects the script before xpui and backs up the original", async () => {
  const script = join(root, "a.js");
  await writeFile(script, "console.log(1);");
  const { hash } = await patcher.apply(script);

  const html = await index();
  expect(html.indexOf("lyrics-translator.js")).toBeLessThan(html.indexOf("xpui-snapshot.js"));
  expect(await $`unzip -p ${spa} lyrics-translator.js`.quiet().text()).toBe("console.log(1);");
  expect((await patcher.patchState()).patchedHash).toBe(hash);
  expect(await Bun.file(join(root, "data/xpui-9.9.9.spa")).exists()).toBe(true);
});

test("reapplying replaces the tag instead of stacking it", async () => {
  const script = join(root, "b.js");
  await writeFile(script, "console.log(2);");
  await patcher.apply(script);
  expect((await index()).match(/lyrics-translator\.js/g)?.length).toBe(1);
});

test("restore returns index.html to the original", async () => {
  expect(await patcher.restore()).toBe(true);
  expect(await index()).toBe(INDEX);
  expect((await patcher.patchState()).patchedHash).toBeNull();
  expect(await patcher.restore()).toBe(false);
});
