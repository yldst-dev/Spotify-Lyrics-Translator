(() => {
  if (window.__lyricsTranslator) return;
  window.__lyricsTranslator = true;

  const API = "http://127.0.0.1:47831";
  const LANG = "ko";
  const LYRICS_URL = /\/color-lyrics\/v2\/track\/([A-Za-z0-9]{22})/;
  const TOKEN = document.currentScript?.dataset.sltToken ?? "";
  const LINE_SELECTOR = '[data-testid="lyrics-line"]';
  const SETTINGS_PAGE = '[data-testid="settings-page"]';
  const SETTINGS_CLASS = "slt-settings";
  const NODE_CLASS = "slt-translation";
  const ENABLED_KEY = "slt:enabled";
  const MAX_TRACKS = 30;
  const SETTLE_MS = 400;
  const RETRY_DELAYS_MS = [10000, 30000, 120000];
  const PLAIN_HTTP_WARNING = "이 주소는 HTTP라서 API 키와 가사가 암호화 없이 전송됩니다. 가능하면 HTTPS 주소를 쓰세요.";
  const DAEMON_DOWN = "번역 데몬에 연결할 수 없습니다. 데몬이 켜져 있는지 확인해 주세요.";
  const SAVE_ERRORS = {
    invalid_url: "API URL 형식이 올바르지 않습니다. http 또는 https 주소를 입력해 주세요.",
    invalid_key: "API 키에 쓸 수 없는 문자가 들어 있습니다.",
    key_required: "다른 서버로 주소를 바꾸면 API 키도 다시 입력해야 합니다.",
    key_missing: "이 번역기의 API 키를 입력해 주세요.",
    invalid_translator: "지원하지 않는 번역기입니다.",
  };
  const TEST_FAILURES = {
    rejected: "API 키가 거부되었습니다. 키를 확인해 주세요.",
    no_credit: "크레딧이 부족합니다.",
    not_found: "주소나 모델을 찾을 수 없습니다. API URL을 확인해 주세요.",
    rate_limited: "요청 한도를 넘었습니다. 잠시 뒤에 다시 시도해 주세요.",
    unreachable: "서버에 연결할 수 없습니다. 주소와 네트워크를 확인해 주세요.",
    timeout: "30초 안에 응답이 없습니다.",
    failed: "연결에 실패했습니다. 자세한 내용은 데몬 로그를 확인해 주세요.",
  };

  const nativeFetch = window.fetch.bind(window);
  const known = new Map();
  const tracks = new Map();
  let wanted = null;
  let active = null;
  let settleTimer = 0;
  let retryTimer = 0;
  let retries = 0;
  let enabled = true;
  try {
    enabled = localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {}

  const normalize = (text) => text.replace(/\s+/g, " ").trim();

  const remember = (map, key, value) => {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_TRACKS) map.delete(map.keys().next().value);
  };

  const api = (path, init = {}) =>
    nativeFetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", "x-slt-token": TOKEN } });

  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  const style = document.createElement("style");
  style.textContent = `
    ${LINE_SELECTOR} .${NODE_CLASS} {
      display: block;
      margin-top: 0.2em;
      font-size: 0.6em;
      font-weight: 500;
      line-height: 1.35;
      letter-spacing: 0;
      opacity: 0.78;
      pointer-events: none;
    }
    html[data-slt-off] .${NODE_CLASS} { display: none; }
    .${SETTINGS_CLASS} { display: grid; gap: 8px; }
    .${SETTINGS_CLASS} h2, .${SETTINGS_CLASS} p { margin: 0; }
    .${SETTINGS_CLASS} h2 { color: var(--text-base); }
    .slt-note { color: var(--text-subdued); }
    .slt-warning { color: var(--text-warning, var(--text-subdued)); }
    .slt-warning:empty, .slt-status:empty { display: none; }
    .slt-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px 20px; padding-block: 8px; }
    .slt-field { display: grid; gap: 8px; }
    .slt-field label { color: var(--text-base); }
    .slt-input { box-sizing: border-box; width: 100%; height: 40px; padding: 0 12px; color: #fff; background: #333; border: 1px solid transparent; border-radius: 4px; font-family: inherit; font-size: 14px; }
    .slt-input:focus { outline: none; border-color: var(--essential-base); }
    .slt-input::placeholder { color: var(--text-subdued); }
    .slt-input:disabled { opacity: 0.5; }
    .slt-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
    .slt-button { min-block-size: 32px; padding: 4px 16px; color: var(--text-base); background: transparent; border: 1px solid var(--essential-subdued); border-radius: 9999px; font-family: inherit; font-size: 14px; font-weight: 700; cursor: pointer; }
    .slt-button:hover:not(:disabled) { border-color: var(--essential-base); }
    .slt-button:focus-visible { outline: 2px solid var(--essential-base); outline-offset: 2px; }
    .slt-button:disabled { opacity: 0.5; cursor: default; }
    .slt-divider { display: var(--settings-section-divider-display, none); width: 100%; margin-block: 16px 0; border: 0; border-top: 1px solid var(--background-tinted-base); }
  `;
  document.head.append(style);
  if (!enabled) document.documentElement.setAttribute("data-slt-off", "");

  const shownLines = () => {
    const texts = [];
    for (const line of document.querySelectorAll(LINE_SELECTOR)) {
      const source = line.firstElementChild;
      if (source && !source.classList.contains(NODE_CLASS)) texts.push({ line, text: normalize(source.textContent) });
    }
    return texts;
  };

  const displayedTrack = (texts) => {
    const words = texts.map(({ text }) => text).filter((text) => /\p{L}/u.test(text));
    if (!words.length) return null;
    let best = null;
    let bestScore = 0;
    for (const [trackId, { lineSet }] of [...known].reverse()) {
      let score = 0;
      for (const text of words) if (lineSet.has(text)) score++;
      if (score > bestScore) {
        best = trackId;
        bestScore = score;
      }
    }
    return bestScore >= Math.min(2, words.length) ? best : null;
  };

  const requestTranslation = async (trackId) => {
    const entry = known.get(trackId);
    if (!entry || tracks.has(trackId) || active?.trackId === trackId || wanted !== trackId) return;
    const job = { trackId, controller: new AbortController() };
    active = job;
    let retry = true;
    try {
      const res = await api("/translate", {
        method: "POST",
        body: JSON.stringify({ trackId, lang: LANG, lines: entry.lines }),
        signal: job.controller.signal,
      });
      if (!res.ok) {
        retry = (await res.json().catch(() => ({}))).retry === true;
        throw new Error(String(res.status));
      }
      const { translations } = await res.json();
      const map = new Map();
      entry.lines.forEach((text, i) => {
        if (translations[i]) map.set(normalize(text), translations[i]);
      });
      remember(tracks, trackId, map);
      scheduleRender();
    } catch {
      const delay = RETRY_DELAYS_MS[retries];
      if (retry && delay && !job.controller.signal.aborted && wanted === trackId) {
        retries++;
        retryTimer = setTimeout(() => requestTranslation(trackId), delay);
      }
    } finally {
      if (active === job) active = null;
    }
  };

  const follow = (shown) => {
    if (shown === wanted) return;
    wanted = shown;
    retries = 0;
    clearTimeout(settleTimer);
    clearTimeout(retryTimer);
    if (active && active.trackId !== shown) {
      active.controller.abort();
      active = null;
    }
    if (shown && !tracks.has(shown)) settleTimer = setTimeout(() => requestTranslation(shown), SETTLE_MS);
  };

  const resetTranslations = () => {
    retries = 0;
    clearTimeout(retryTimer);
    active?.controller.abort();
    active = null;
    tracks.clear();
    scheduleRender();
    if (wanted) requestTranslation(wanted);
  };

  const field = (label, input) => el("div", { className: "slt-field" }, el("label", { className: "encore-text-body-small", htmlFor: input.id, textContent: label }), input);

  const buildSettings = () => {
    const translator = el("select", { id: "slt-translator", className: "slt-input" });
    const url = el("input", { id: "slt-api-url", className: "slt-input", type: "url", required: true, spellcheck: false, autocomplete: "off", placeholder: "https://example.com/v1" });
    const key = el("input", { id: "slt-api-key", className: "slt-input", type: "password", spellcheck: false, autocomplete: "new-password" });
    const note = el("p", { className: "slt-note encore-text-body-small", textContent: "저장하면 바로 적용됩니다. 연결 테스트는 입력한 값으로 짧은 문장 하나를 번역해 보며, 저장하지는 않습니다." });
    const warning = el("p", { id: "slt-api-url-warning", className: "slt-warning encore-text-body-small" });
    const status = el("p", { className: "slt-status slt-note encore-text-body-small" });
    const save = el("button", { className: "slt-button", type: "submit", textContent: "저장" });
    const test = el("button", { className: "slt-button", type: "button", textContent: "연결 테스트" });
    let translators = [];
    url.setAttribute("aria-describedby", warning.id);
    status.setAttribute("role", "status");

    const report = (text, failed = false) => {
      status.textContent = text;
      status.classList.toggle("slt-warning", failed);
    };
    const setBusy = (busy) => {
      save.disabled = test.disabled = busy;
    };
    const fill = (id) => {
      const current = translators.find((item) => item.id === id) ?? translators[0];
      translator.value = current.id;
      url.value = current.apiUrl;
      key.value = "";
      key.placeholder = current.hasKey ? "저장된 키 유지 (바꿀 때만 입력)" : "API 키 입력";
      warning.textContent = current.plainHttp ? PLAIN_HTTP_WARNING : "";
    };
    const show = (settings) => {
      translators = settings.translators;
      translator.replaceChildren(...translators.map(({ id, label }) => el("option", { value: id, textContent: label })));
      fill(settings.translator);
    };
    const values = () => JSON.stringify({ translator: translator.value, apiUrl: url.value, apiKey: key.value });

    const form = el(
      "form",
      { className: SETTINGS_CLASS },
      el("h2", { className: "encore-text-body-medium-bold", textContent: "가사 번역" }),
      note,
      el("div", { className: "slt-fields" }, field("번역기", translator)),
      el("div", { className: "slt-fields" }, field("API URL", url), field("API 키", key)),
      warning,
      el("div", { className: "slt-actions" }, save, test, status),
      el("hr", { className: "slt-divider" }),
    );

    translator.addEventListener("change", () => {
      report("");
      fill(translator.value);
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setBusy(true);
      report("저장하는 중입니다.");
      try {
        const res = await api("/settings", { method: "POST", body: values() });
        const body = await res.json();
        if (!res.ok) {
          report(SAVE_ERRORS[body.error] ?? DAEMON_DOWN, true);
          return;
        }
        show(body);
        report("저장했습니다.");
        resetTranslations();
      } catch {
        report(DAEMON_DOWN, true);
      } finally {
        setBusy(false);
      }
    });

    test.addEventListener("click", async () => {
      if (!form.reportValidity()) return;
      setBusy(true);
      report("연결을 확인하는 중입니다. 최대 30초 걸릴 수 있습니다.");
      try {
        const res = await api("/settings/test", { method: "POST", body: values() });
        const body = await res.json();
        if (!res.ok) report(SAVE_ERRORS[body.error] ?? DAEMON_DOWN, true);
        else if (body.ok) report(`연결에 성공했습니다. (${body.provider}, ${body.ms}ms)`);
        else report(TEST_FAILURES[body.failure] ?? TEST_FAILURES.failed, true);
      } catch {
        report(DAEMON_DOWN, true);
      } finally {
        setBusy(false);
      }
    });

    setBusy(true);
    api("/settings")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((settings) => {
        show(settings);
        setBusy(false);
      })
      .catch(() => report(DAEMON_DOWN, true));
    return form;
  };

  const renderSettings = () => {
    const page = document.querySelector(SETTINGS_PAGE);
    if (!page || page.querySelector(`.${SETTINGS_CLASS}`)) return;
    const firstSection = [...page.children].find((child) => child.querySelector("h2"));
    if (firstSection) page.insertBefore(buildSettings(), firstSection);
  };

  const render = () => {
    const texts = shownLines();
    const shown = displayedTrack(texts);
    const translations = tracks.get(shown);
    for (const { line, text } of texts) {
      const translation = translations?.get(text);
      let node = line.querySelector(`:scope > .${NODE_CLASS}`);
      if (!translation) {
        node?.remove();
        continue;
      }
      if (!node) {
        node = document.createElement("span");
        node.className = NODE_CLASS;
        line.append(node);
      }
      if (node.textContent !== translation) node.textContent = translation;
    }
    follow(enabled ? shown : null);
    renderSettings();
  };

  let scheduled = false;
  const scheduleRender = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      render();
    });
  };

  const onLyrics = (trackId, body) => {
    const lines = body?.lyrics?.lines?.map((line) => line.words ?? "");
    if (!lines?.length) return;
    remember(known, trackId, { lines, lineSet: new Set(lines.map(normalize)) });
    scheduleRender();
  };

  window.fetch = async function (input, init) {
    const response = await nativeFetch(input, init);
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const match = response.ok && url.match(LYRICS_URL);
    if (match) {
      response
        .clone()
        .json()
        .then((body) => onLyrics(match[1], body))
        .catch(() => {});
    }
    return response;
  };

  document.addEventListener("keydown", (event) => {
    if (!event.altKey || event.shiftKey || event.metaKey || event.ctrlKey || event.repeat || event.code !== "KeyT") return;
    if (event.target?.closest?.("input, textarea, [contenteditable]")) return;
    enabled = !enabled;
    document.documentElement.toggleAttribute("data-slt-off", !enabled);
    try {
      localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
    } catch {}
    scheduleRender();
  });

  new MutationObserver(scheduleRender).observe(document.body, { childList: true, subtree: true, characterData: true });
  scheduleRender();
})();
