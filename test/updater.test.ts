import { $ } from "bun";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUpdate, currentVersion, isNewer, latestRelease } from "../src/updater";

const roots: string[] = [];
afterAll(() => Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }))));

const git = (dir: string, args: string[]) => $`git -C ${dir} -c user.name=test -c user.email=test@example.com ${args}`.quiet();

async function commitVersion(dir: string, version: string, tag?: string) {
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version }));
  await git(dir, ["add", "package.json"]);
  await git(dir, ["commit", "-q", "-m", version]);
  if (tag) await git(dir, ["tag", tag]);
}

let upstream: string;
let clone: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "slt-up-"));
  roots.push(root);
  upstream = join(root, "upstream");
  clone = join(root, "clone");
  await $`git init -q -b main ${upstream}`.quiet();
  await commitVersion(upstream, "0.1.0", "v0.1.0");
  await $`git clone -q ${upstream} ${clone}`.quiet();
  await commitVersion(upstream, "0.2.0", "v0.2.0");
  await commitVersion(upstream, "0.3.0-dev");
});

test("isNewer compares semantic versions", () => {
  expect(isNewer("v0.2.0", "0.1.9")).toBe(true);
  expect(isNewer("v0.10.0", "0.9.0")).toBe(true);
  expect(isNewer("v1.0.0", "1.0.0")).toBe(false);
  expect(isNewer("v0.1.0", "0.2.0")).toBe(false);
  expect(isNewer("latest", "0.1.0")).toBe(false);
});

test("latestRelease reads a stable vX.Y.Z tag and ignores anything else", async () => {
  const respond = (body: object, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
  expect(await latestRelease("o/r", respond({ tag_name: "v0.2.0" }))).toBe("v0.2.0");
  expect(await latestRelease("o/r", respond({ tag_name: "v0.3.0-rc.1" }))).toBeNull();
  expect(await latestRelease("o/r", respond({ tag_name: "v0.3.0", prerelease: true }))).toBeNull();
  expect(await latestRelease("o/r", respond({ message: "Not Found" }, 404))).toBeNull();
  await expect(latestRelease("o/r", respond({ message: "rate limited" }, 403))).rejects.toThrow("403");
});

test("fast-forwards a clean checkout to the release tag, not past it", async () => {
  const result = await applyUpdate("v0.2.0", { root: clone, remote: upstream });
  expect(result).toMatchObject({ status: "updated", to: "v0.2.0" });
  expect(await currentVersion(clone)).toBe("0.2.0");
  expect((await git(clone, ["symbolic-ref", "--short", "HEAD"]).text()).trim()).toBe("main");
  expect(await applyUpdate("v0.2.0", { root: clone, remote: upstream })).toEqual({ status: "skipped", reason: "already at release" });
});

test("skips when tracked files have local changes", async () => {
  await writeFile(join(clone, "package.json"), "{}");
  expect(await applyUpdate("v0.2.0", { root: clone, remote: upstream })).toEqual({ status: "skipped", reason: "local changes" });
});

test("untracked files such as .env do not block the update", async () => {
  await writeFile(join(clone, ".env"), "KEY=x");
  expect((await applyUpdate("v0.2.0", { root: clone, remote: upstream })).status).toBe("updated");
});

test("skips when the checkout has commits the release does not have", async () => {
  await writeFile(join(clone, "local.txt"), "mine");
  await git(clone, ["add", "local.txt"]);
  await git(clone, ["commit", "-q", "-m", "local"]);
  expect(await applyUpdate("v0.2.0", { root: clone, remote: upstream })).toEqual({
    status: "skipped",
    reason: "local commits are not in the release",
  });
});

test("a detached checkout moves to the tag", async () => {
  await git(clone, ["checkout", "-q", "--detach", "HEAD"]);
  expect((await applyUpdate("v0.2.0", { root: clone, remote: upstream })).status).toBe("updated");
  expect(await currentVersion(clone)).toBe("0.2.0");
});

test("rejects tags that are not vX.Y.Z and folders that are not git checkouts", async () => {
  expect(await applyUpdate("main", { root: clone, remote: upstream })).toEqual({ status: "skipped", reason: "invalid tag main" });
  const plain = await mkdtemp(join(tmpdir(), "slt-plain-"));
  roots.push(plain);
  expect(await applyUpdate("v0.2.0", { root: plain, remote: upstream })).toEqual({ status: "skipped", reason: "not a git checkout" });
});
