import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, SPOTIFY_ORIGIN } from "./config";
import { loadToken } from "./patcher";

export const UPDATE_REPO = process.env.SLT_UPDATE_REPO ?? "yldst-dev/Spotify-Lyrics-Translator";
const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const SIGNERS_FILE = "release-signers";
const BOOT_TIMEOUT_MS = 15_000;

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

const freePort = () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port as number;
};

export async function daemonBoots(root = ROOT) {
  const dataDir = await mkdtemp(join(tmpdir(), "slt-boot-"));
  const port = freePort();
  const token = await loadToken(dataDir);
  const child = Bun.spawn([process.execPath, join(root, "src/daemon.ts")], {
    cwd: dataDir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SLT_DATA_DIR: dataDir,
      SLT_ENV_FILE: join(dataDir, ".env"),
      SLT_PORT: String(port),
      SLT_TRANSLATOR: "mock",
      SLT_AUTO_UPDATE: "0",
      SPOTIFY_APP: join(dataDir, "none.app"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline && child.exitCode === null) {
      const res = await fetch(`http://127.0.0.1:${port}/translate`, {
        method: "POST",
        headers: { origin: SPOTIFY_ORIGIN, "x-slt-token": token, "content-type": "application/json" },
        body: JSON.stringify({ trackId: "0".repeat(22), lang: "ko", lines: ["boot check"] }),
      }).catch(() => null);
      if (res?.ok) return true;
      await Bun.sleep(200);
    }
    return false;
  } finally {
    child.kill(9);
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function applyUpdate(
  tag: string,
  {
    root = ROOT,
    remote = `https://github.com/${UPDATE_REPO}.git`,
    verify = daemonBoots,
  }: { root?: string; remote?: string; verify?: (root: string) => Promise<boolean> } = {},
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

  const signers = join(root, SIGNERS_FILE);
  if (await Bun.file(signers).exists()) {
    const body = await git(["cat-file", "tag", tag]).nothrow();
    const trusted =
      body.exitCode === 0 &&
      body.text().includes("BEGIN SSH SIGNATURE") &&
      (await git(["-c", `gpg.ssh.allowedSignersFile=${signers}`, "verify-tag", tag]).nothrow()).exitCode === 0;
    if (!trusted) return skip("release signature is not trusted");
  }

  const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"]).nothrow().text()).trim();
  if (branch) await git(["merge", "--ff-only", "--quiet", target]);
  else await git(["checkout", "--quiet", "--detach", target]);

  if (!(await verify(root).catch(() => false))) {
    await git(["reset", "--keep", from]);
    return skip("release failed its startup check and was rolled back");
  }
  return { status: "updated", from: from.slice(0, 7), to: tag };
}

export async function isSpotifyRunning() {
  return (await $`pgrep -x Spotify`.quiet().nothrow()).exitCode === 0;
}
