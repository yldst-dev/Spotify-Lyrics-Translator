import { $ } from "bun";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, DEV_LOADER, EXTENSION, LAUNCHD_LABEL, ROOT } from "./config";
import { spotify } from "./patcher";

const PLIST = join(homedir(), "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const DOMAIN = `gui/${process.getuid?.()}`;

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const plist = (logPath: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(join(ROOT, "src/daemon.ts"))}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;

async function install() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(join(homedir(), "Library/LaunchAgents"), { recursive: true });
  await $`launchctl bootout ${DOMAIN}/${LAUNCHD_LABEL}`.quiet().nothrow();
  await writeFile(PLIST, plist(join(DATA_DIR, "daemon.log")));
  await $`launchctl bootstrap ${DOMAIN} ${PLIST}`;
  console.log(`installed ${PLIST}`);
}

async function restart() {
  await $`launchctl kickstart -k ${DOMAIN}/${LAUNCHD_LABEL}`;
  console.log("restarted");
}

async function logs() {
  await $`tail -n 50 -f ${join(DATA_DIR, "daemon.log")}`;
}

async function uninstall() {
  await $`launchctl bootout ${DOMAIN}/${LAUNCHD_LABEL}`.quiet().nothrow();
  await rm(PLIST, { force: true });
  console.log("uninstalled");
}

const commands: Record<string, () => Promise<unknown>> = {
  apply: async () => console.log(await spotify.apply(EXTENSION)),
  dev: async () => console.log(await spotify.apply(DEV_LOADER)),
  restore: async () => console.log((await spotify.restore()) ? "restored" : "not patched"),
  status: async () => console.log({ spa: spotify.spa, ...(await spotify.patchState()) }),
  install,
  restart,
  logs,
  uninstall,
};

const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error(`usage: bun src/cli.ts <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}
await command();
