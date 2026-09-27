import { $ } from "bun";
import { join } from "node:path";
import { ROOT } from "./config";

export const UPDATE_REPO = process.env.SLT_UPDATE_REPO ?? "yldst-dev/Spotify-Lyrics-Translator";
const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export type UpdateResult = { status: "updated"; from: string; to: string } | { status: "skipped"; reason: string };

const parseVersion = (value: string) => {
  const match = (value.startsWith("v") ? value : `v${value}`).match(VERSION_TAG);
  return match ? match.slice(1).map(Number) : null;
};

export function isNewer(candidate: string, current: string) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export async function currentVersion(root = ROOT) {
  return ((await Bun.file(join(root, "package.json")).json()) as { version: string }).version;
}

export async function latestRelease(repo = UPDATE_REPO, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "spotify-lyrics-translator" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub releases ${res.status}`);
  const release = (await res.json()) as { tag_name?: string; draft?: boolean; prerelease?: boolean };
  if (!release.tag_name || release.draft || release.prerelease || !VERSION_TAG.test(release.tag_name)) return null;
  return release.tag_name;
}

export async function applyUpdate(
  tag: string,
  { root = ROOT, remote = `https://github.com/${UPDATE_REPO}.git` }: { root?: string; remote?: string } = {},
): Promise<UpdateResult> {
  const skip = (reason: string): UpdateResult => ({ status: "skipped", reason });
  if (!VERSION_TAG.test(tag)) return skip(`invalid tag ${tag}`);
  const git = (args: string[]) => $`git -C ${root} ${args}`.quiet();

  if ((await git(["rev-parse", "--is-inside-work-tree"]).nothrow()).exitCode !== 0) return skip("not a git checkout");
  if ((await git(["status", "--porcelain", "--untracked-files=no"]).text()).trim()) return skip("local changes");

  await git(["fetch", "--quiet", "--no-tags", remote, `+refs/tags/${tag}:refs/tags/${tag}`]);
  const from = (await git(["rev-parse", "HEAD"]).text()).trim();
  const target = (await git(["rev-parse", `${tag}^{commit}`]).text()).trim();
  if (from === target) return skip("already at release");
  if ((await git(["merge-base", "--is-ancestor", "HEAD", target]).nothrow()).exitCode !== 0) return skip("local commits are not in the release");

  const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"]).nothrow().text()).trim();
  if (branch) await git(["merge", "--ff-only", "--quiet", target]);
  else await git(["checkout", "--quiet", "--detach", target]);
  return { status: "updated", from: from.slice(0, 7), to: tag };
}

export async function isSpotifyRunning() {
  return (await $`pgrep -x Spotify`.quiet().nothrow()).exitCode === 0;
}
