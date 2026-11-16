import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLog } from "../src/logs";

const dir = await mkdtemp(join(tmpdir(), "slt-logs-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

test("rotateLog keeps a copy and empties the log once it passes the limit", async () => {
  const path = join(dir, "daemon.log");
  await writeFile(path, "x".repeat(100));
  expect(await rotateLog(path, 1000)).toBe(false);
  expect((await stat(path)).size).toBe(100);
  expect(await rotateLog(path, 50)).toBe(true);
  expect((await stat(path)).size).toBe(0);
  expect(await Bun.file(`${path}.1`).text()).toBe("x".repeat(100));
});

test("rotateLog ignores a missing file", async () => {
  expect(await rotateLog(join(dir, "none.log"), 1)).toBe(false);
});
