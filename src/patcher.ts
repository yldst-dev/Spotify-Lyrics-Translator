import { $ } from "bun";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP, DATA_DIR } from "./config";

const SCRIPT_NAME = "lyrics-translator.js";
const MARKER = "data-lyrics-translator";
const TAG_PATTERN = /<script[^>]*data-lyrics-translator[^>]*><\/script>/g;
const HASH_PATTERN = /data-lyrics-translator="([0-9a-f]+)"/;
const ANCHOR = '<script defer="defer" src="/xpui-snapshot.js">';

export type PatchState = { version: string; patchedHash: string | null };

export const hashFile = async (path: string, salt = "") =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).update(salt).digest("hex").slice(0, 16);

export async function loadToken(dataDir: string) {
  const path = join(dataDir, "auth-token");
  const saved = (await Bun.file(path).text().catch(() => "")).trim();
  if (saved) return saved;
  const token = randomBytes(32).toString("hex");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, token, { mode: 0o600, flag: "wx" });
  return token;
}

const withStaging = async (work: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "slt-"));
  try {
    await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export function createPatcher({ app, dataDir }: { app: string; dataDir: string }) {
  const spa = join(app, "Contents/Resources/Apps/xpui.spa");

  const spotifyVersion = async () =>
    (await $`defaults read ${join(app, "Contents/Info.plist")} CFBundleShortVersionString`.quiet().text()).trim();

  const readIndex = () => $`unzip -p ${spa} index.html`.quiet().text();

  async function backup(version: string) {
    const target = join(dataDir, `xpui-${version}.spa`);
    if (await Bun.file(target).exists()) return;
    await mkdir(dataDir, { recursive: true });
    await copyFile(spa, target);
    const others = (await readdir(dataDir))
      .filter((name) => /^xpui-.+\.spa$/.test(name))
      .map((name) => join(dataDir, name))
      .filter((path) => path !== target);
    const byAge = await Promise.all(others.map(async (path) => ({ path, mtime: (await stat(path)).mtimeMs })));
    await Promise.all(byAge.sort((a, b) => b.mtime - a.mtime).slice(1).map(({ path }) => rm(path)));
  }

  async function patchState(): Promise<PatchState> {
    const index = await readIndex();
    return {
      version: await spotifyVersion(),
      patchedHash: index.match(HASH_PATTERN)?.[1] ?? (index.includes(MARKER) ? "" : null),
    };
  }

  async function apply(scriptPath: string) {
    if (!(await Bun.file(scriptPath).exists())) throw new Error(`script not found: ${scriptPath}`);
    const [version, index, token] = await Promise.all([spotifyVersion(), readIndex(), loadToken(dataDir)]);
    const hash = await hashFile(scriptPath, token);
    if (!index.includes(MARKER)) await backup(version);

    const tag = `<script defer="defer" src="/${SCRIPT_NAME}" ${MARKER}="${hash}" data-slt-token="${token}"></script>`;
    const clean = index.replace(TAG_PATTERN, "");
    const patched = clean.includes(ANCHOR) ? clean.replace(ANCHOR, tag + ANCHOR) : clean.replace("</body>", `${tag}</body>`);

    await withStaging(async (dir) => {
      await writeFile(join(dir, "index.html"), patched);
      await copyFile(scriptPath, join(dir, SCRIPT_NAME));
      await $`zip -q -X ${spa} index.html ${SCRIPT_NAME}`.cwd(dir).quiet();
    });
    return { version, hash };
  }

  async function restore() {
    const index = await readIndex();
    if (!index.includes(MARKER)) return false;
    await withStaging(async (dir) => {
      await writeFile(join(dir, "index.html"), index.replace(TAG_PATTERN, ""));
      await $`zip -q -X ${spa} index.html`.cwd(dir).quiet();
      await $`zip -q -d ${spa} ${SCRIPT_NAME}`.quiet().nothrow();
    });
    return true;
  }

  return { spa, patchState, apply, restore };
}

export const spotify = createPatcher({ app: APP, dataDir: DATA_DIR });
