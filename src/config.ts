import { homedir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const APP = process.env.SPOTIFY_APP ?? "/Applications/Spotify.app";
export const DATA_DIR = process.env.SLT_DATA_DIR ?? join(homedir(), "Library/Application Support/spotify-lyrics-translator");
export const PORT = Number(process.env.SLT_PORT ?? 47831);
export const SPOTIFY_ORIGIN = "https://xpui.app.spotify.com";
export const EXTENSION = join(ROOT, "extension/lyrics-translator.js");
export const DEV_LOADER = join(ROOT, "extension/dev-loader.js");
export const DEV = process.env.SLT_DEV === "1";
export const LAUNCHD_LABEL = "local.spotify-lyrics-translator";
