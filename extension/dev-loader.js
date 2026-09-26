(() => {
  const API = "http://127.0.0.1:47831";

  const getSync = (path) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `${API}${path}`, false);
    xhr.send();
    if (xhr.status !== 200) throw new Error(`${path} ${xhr.status}`);
    return xhr.responseText;
  };

  let loaded = null;
  try {
    loaded = getSync("/dev/version");
    const script = document.createElement("script");
    script.textContent = `${getSync("/dev/extension.js")}\n//# sourceURL=${API}/dev/extension.js`;
    document.head.append(script);
  } catch {}

  const post = (data) =>
    fetch(`${API}/dev/log`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }).catch(() => {});

  setInterval(async () => {
    try {
      const version = await (await fetch(`${API}/dev/version`, { cache: "no-store" })).text();
      if (loaded !== null && version !== loaded) location.reload();
    } catch {}
  }, 2000);

  let lastStats = "";
  setInterval(() => {
    const stats = JSON.stringify({
      lines: document.querySelectorAll('[data-testid="lyrics-line"]').length,
      translated: document.querySelectorAll('[data-testid="lyrics-line"] > .slt-translation').length,
      off: document.documentElement.hasAttribute("data-slt-off"),
    });
    if (stats !== lastStats) post(JSON.parse((lastStats = stats)));
  }, 3000);
})();
