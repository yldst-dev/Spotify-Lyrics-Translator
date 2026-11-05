import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeUsesPlainHttp, normalizeApiUrl, readSettings, resolveSettings, runConnectionTest, saveSettings, updateEnvFile, usesPlainHttp } from "../src/settings";

const dir = mkdtempSync(join(tmpdir(), "slt-settings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("normalizeApiUrl keeps plain http(s) addresses and drops anything that could smuggle data", () => {
  expect(normalizeApiUrl(" https://example.com/v1/ ")).toBe("https://example.com/v1");
  expect(normalizeApiUrl("http://[::1]:8080/v1")).toBe("http://[::1]:8080/v1");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "https://a@b.example", "https://b.example/#x", "https://b.example/?q=1", "", 7, null]) {
    expect(normalizeApiUrl(bad)).toBeNull();
  }
  expect(normalizeApiUrl("https://b.example/a b'$c")).toBeNull();
});

test("usesPlainHttp flags http unless it stays on this machine", () => {
  expect(usesPlainHttp("http://192.168.0.2:8080/v1")).toBe(true);
  expect(usesPlainHttp("https://example.com/v1")).toBe(false);
  for (const local of ["http://localhost:1/v1", "http://127.0.0.1:1/v1", "http://[::1]:1/v1"]) expect(usesPlainHttp(local)).toBe(false);
});

test("readSettings lists every translator without any key", () => {
  const settings = readSettings({ SLT_TRANSLATOR: "openrouter", OPENROUTER_API_KEY: "secret-value", CODEX_GATEWAY_BASE_URL: "http://192.168.0.2:8080/v1" });
  expect(settings.translator).toBe("openrouter");
  expect(settings.translators).toEqual([
    { id: "codex", label: "Codex Gateway", apiUrl: "http://192.168.0.2:8080/v1", hasKey: false, plainHttp: true },
    { id: "openrouter", label: "OpenRouter", apiUrl: "https://openrouter.ai/api/v1", hasKey: true, plainHttp: false },
    { id: "claude", label: "Claude", apiUrl: "https://api.anthropic.com", hasKey: false, plainHttp: false },
    { id: "openai", label: "OpenAI (ChatGPT API)", apiUrl: "https://api.openai.com/v1", hasKey: false, plainHttp: false },
  ]);
  expect(JSON.stringify(settings)).not.toContain("secret-value");
});

test("the plain http warning follows the active translator", () => {
  const env = { CODEX_GATEWAY_BASE_URL: "http://192.168.0.2:8080/v1" };
  expect(activeUsesPlainHttp(env)).toBe(true);
  expect(activeUsesPlainHttp({ ...env, SLT_TRANSLATOR: "openai" })).toBe(false);
  expect(activeUsesPlainHttp({ ...env, SLT_TRANSLATOR: "mock" })).toBe(false);
});

test("only known translators are accepted, including names found on Object.prototype", () => {
  for (const translator of ["nope", "mock", "__proto__", "constructor", "toString", 7]) {
    expect(resolveSettings({ translator, apiUrl: "https://example.com", apiKey: "k" }, {})).toBe("invalid_translator");
  }
  expect(resolveSettings({ apiUrl: "https://example.com", apiKey: "k" }, { SLT_TRANSLATOR: "mock" })).toBe("invalid_translator");
});

test("a translator without a saved key needs one", () => {
  expect(resolveSettings({ translator: "openai", apiUrl: "https://api.openai.com/v1" }, {})).toBe("key_missing");
});

test("switching keeps a saved key only for the same server", () => {
  const env = { OPENAI_API_KEY: "saved" };
  expect(resolveSettings({ translator: "openai", apiUrl: "https://api.openai.com/v1" }, env)).toEqual({
    SLT_TRANSLATOR: "openai",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
  });
  expect(resolveSettings({ translator: "openai", apiUrl: "https://attacker.example/v1" }, env)).toBe("key_required");
});

test("a key saved for one translator is not used to satisfy another", () => {
  expect(resolveSettings({ translator: "claude", apiUrl: "https://api.anthropic.com" }, { OPENAI_API_KEY: "saved" })).toBe("key_missing");
});

test("the connection test fails on an empty answer and passes on a real one", async () => {
  const provider = (lines: { i: number; text: string }[]) => ({ id: "t", translate: async () => lines });
  const signal = new AbortController().signal;
  await expect(runConnectionTest(provider([{ i: 0, text: "  " }]), signal)).rejects.toThrow("empty answer");
  await expect(runConnectionTest(provider([{ i: 0, text: "번역" }]), signal)).resolves.toBeUndefined();
});

test("saving writes the active translator's variables and updates env", async () => {
  const path = join(dir, "save.env");
  const env: Record<string, string | undefined> = { SLT_TRANSLATOR: "claude" };
  expect(await saveSettings({ apiUrl: "https://proxy.example", apiKey: " sk-ant-1 " }, env, path)).toBeNull();
  expect(env).toMatchObject({ ANTHROPIC_BASE_URL: "https://proxy.example", ANTHROPIC_API_KEY: "sk-ant-1" });
  const saved = await Bun.file(path).text();
  expect(saved).toContain("ANTHROPIC_API_KEY=sk-ant-1\n");
  expect(saved).toContain("SLT_TRANSLATOR=claude\n");
});

test("updateEnvFile replaces every copy of a variable, keeps the rest, and stays private", async () => {
  const path = join(dir, "update.env");
  await writeFile(path, '# note\nA=1\nexport B="old"\nC=3\nB=older\n', { mode: 0o644 });
  await updateEnvFile(path, { B: "new$1", D: "added" });
  expect(await Bun.file(path).text()).toBe("# note\nA=1\nB=new$1\nC=3\nB=new$1\nD=added\n");
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("updateEnvFile creates a missing file", async () => {
  const path = join(dir, "fresh.env");
  await updateEnvFile(path, { A: "1" });
  expect((await Bun.file(path).text()).trim()).toBe("A=1");
});
