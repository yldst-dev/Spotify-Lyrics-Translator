(() => {
  if (window.__lyricsTranslator) return;
  window.__lyricsTranslator = true;

  const API = "http://127.0.0.1:47831";
  const LANG = "ko";
  const LYRICS_URL = /\/color-lyrics\/v2\/track\/([A-Za-z0-9]{22})/;
  const LINE_SELECTOR = '[data-testid="lyrics-line"]';
  const NODE_CLASS = "slt-translation";
  const ENABLED_KEY = "slt:enabled";
  const MAX_TRACKS = 30;
  const SETTLE_MS = 400;
  const RETRY_MS = 10000;

  const nativeFetch = window.fetch.bind(window);
  const known = new Map();
  const tracks = new Map();
  let wanted = null;
  let active = null;
  let settleTimer = 0;
  let retryTimer = 0;
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

  const lookup = (text) => {
    for (const translations of [...tracks.values()].reverse()) {
      const hit = translations.get(text);
      if (hit !== undefined) return hit;
    }
    return null;
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
    try {
      const res = await nativeFetch(`${API}/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trackId, lang: LANG, lines: entry.lines }),
        signal: job.controller.signal,
      });
      if (!res.ok) throw new Error(String(res.status));
      const { translations } = await res.json();
      const map = new Map();
      entry.lines.forEach((text, i) => {
        if (translations[i]) map.set(normalize(text), translations[i]);
      });
      remember(tracks, trackId, map);
      scheduleRender();
    } catch {
      if (!job.controller.signal.aborted && wanted === trackId) retryTimer = setTimeout(() => requestTranslation(trackId), RETRY_MS);
    } finally {
      if (active === job) active = null;
    }
  };

  const follow = (texts) => {
    const shown = enabled ? displayedTrack(texts) : null;
    if (shown === wanted) return;
    wanted = shown;
    clearTimeout(settleTimer);
    clearTimeout(retryTimer);
    if (active && active.trackId !== shown) {
      active.controller.abort();
      active = null;
    }
    if (shown && !tracks.has(shown)) settleTimer = setTimeout(() => requestTranslation(shown), SETTLE_MS);
  };

  const render = () => {
    const texts = shownLines();
    for (const { line, text } of texts) {
      const translation = lookup(text);
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
    follow(texts);
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
    if (!event.altKey || event.shiftKey || event.metaKey || event.ctrlKey || event.code !== "KeyT") return;
    enabled = !enabled;
    document.documentElement.toggleAttribute("data-slt-off", !enabled);
    try {
      localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
    } catch {}
    scheduleRender();
  });

  new MutationObserver(scheduleRender).observe(document.body, { childList: true, subtree: true, characterData: true });
})();
