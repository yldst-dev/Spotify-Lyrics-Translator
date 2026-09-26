import { $ } from "bun";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP, DATA_DIR } from "./config";

const SCRIPT_NAME = "lyrics-translator.js";
const MARKER = "data-lyrics-translator";
const TAG_PATTERN = /<script[^>]*data-lyrics-translator[^>]*><\/script>/g;
const HASH_PATTERN = /data-lyrics-translator="([0-9a-f]+)"/;
const ANCHOR = '<script defer="defer" src="/xpui-snapshot.js">';

export type PatchState = { version: string; patchedHash: string | null };

export const hashFile = async (path: string) =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex").slice(0, 16);

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
    const [version, index, hash] = await Promise.all([spotifyVersion(), readIndex(), hashFile(scriptPath)]);
    if (!index.includes(MARKER)) await backup(version);

    const tag = `<script defer="defer" src="/${SCRIPT_NAME}" ${MARKER}="${hash}"></script>`;
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
