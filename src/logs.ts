import { copyFile, stat, truncate } from "node:fs/promises";

export async function rotateLog(path: string, maxBytes: number) {
  const size = (await stat(path).catch(() => null))?.size ?? 0;
  if (size <= maxBytes) return false;
  await copyFile(path, `${path}.1`);
  await truncate(path, 0);
  return true;
}
