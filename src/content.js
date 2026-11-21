/*
 * The Extract button. Shown on janitorai.com/characters/... pages only.
 * One click: read the character + lorebooks through JanitorAI's own API (as
 * the signed-in user), download the avatar and every description image, and
 * save a PNG character card.
 */
(function () {
  "use strict";

  const C = globalThis.JCX;
  if (!C || globalThis.__jcxMounted) return;
  globalThis.__jcxMounted = true;

  const API_TIMEOUT_MS = 20000;
  const MAX_AVATAR_SIDE = 2048;

  // --------------------------------------------------------------- auth --
  // JanitorAI's API wants the Supabase access token the site keeps in
  // localStorage or cookies (sometimes split across .0/.1/... chunks).

  function b64urlToText(v) {
    try {
      const s = v.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
      return new TextDecoder().decode(C.base64ToBytes(s.padEnd(Math.ceil(s.length / 4) * 4, "=")));
    } catch {
      return "";
    }
  }

  function tokenFrom(raw) {
    let s = String(raw || "").trim();
    if (!s) return null;
    if (s.startsWith("base64-")) s = b64urlToText(s.slice(7));
    let d;
    try {
      d = JSON.parse(s);
    } catch {
      const m = s.match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/);
      return m ? m[0] : null;
    }
    if (Array.isArray(d) && typeof d[0] === "string") return d[0];
    if (d && typeof d.access_token === "string") return d.access_token;
    if (d && d.currentSession && typeof d.currentSession.access_token === "string") return d.currentSession.access_token;
    return null;
  }

  function tokenCandidates(store) {
    const groups = new Map();
    for (const key of Object.keys(store)) {
      const m = key.match(/^(sb-.+-auth-token)(?:\.(\d+))?$/);
      if (!m) continue;
      if (!groups.has(m[1])) groups.set(m[1], { whole: null, parts: [] });
      if (m[2] === undefined) groups.get(m[1]).whole = store[key];
      else groups.get(m[1]).parts.push([Number(m[2]), store[key]]);
    }
    const out = [];
    for (const g of groups.values()) {
      if (g.whole) out.push(g.whole);
      if (g.parts.length) out.push(g.parts.sort((a, b) => a[0] - b[0]).map((p) => p[1]).join(""));
    }
    return out;
  }

  function accessToken() {
    const raws = [];
    try {
      const ls = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("sb-")) ls[k] = localStorage.getItem(k) || "";
      }
      raws.push(...tokenCandidates(ls));
    } catch {}
    try {
      const jar = {};
      for (const part of (document.cookie || "").split(";")) {
        const i = part.indexOf("=");
        if (i <= 0) continue;
        let v = part.slice(i + 1).trim();
        try {
          v = decodeURIComponent(v);
        } catch {}
        jar[part.slice(0, i).trim()] = v;
      }
      raws.push(...tokenCandidates(jar));
    } catch {}
    for (const raw of raws) {
      const t = tokenFrom(raw);
      if (t) return t;
    }
    return null;
  }

  // ---------------------------------------------------------------- api --

  class ApiError extends Error {
    constructor(status) {
      super("HTTP " + status);
      this.status = status;
    }
  }

  async function getJson(path, withToken = true) {
    const headers = { Accept: "application/json" };
    const token = withToken ? accessToken() : null;
    if (token) headers.Authorization = "Bearer " + token;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(path, { headers, credentials: "include", signal: ctrl.signal });
      if (!res.ok) {
        // A stale token can make a public resource fail; try once without it.
        if (token && (res.status === 401 || res.status === 403)) return getJson(path, false);
        throw new ApiError(res.status);
      }
      try {
        return JSON.parse(await res.text());
      } catch {
        throw new ApiError("non-json");
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(e && e.name === "AbortError" ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
  }

  function friendlyError(e) {
    const s = e && e.status;
    if (s === 401 || s === 403)
      return "JanitorAI refused the request. Make sure you're signed in, reload the page and try again.";
    if (s === 404) return "This character can't be found. It may be private or deleted.";
    if (s === 429) return "JanitorAI is rate limiting you. Wait a minute and try again.";
    if (s === "context") return "The extension was updated. Reload this page and try again.";
    if (s) return "Couldn't read the character from JanitorAI (" + (typeof s === "number" ? "HTTP " + s : s) + ").";
    return "Something went wrong: " + ((e && e.message) || e);
  }

  // ------------------------------------------------------------- images --

  function viaWorker(url) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "jcx:image", url }, (res) => {
          void chrome.runtime.lastError;
          resolve(res && res.ok ? res : null);
        });
      } catch {
        resolve(null); // extension reloaded under the page
      }
    });
  }

  async function direct(url) {
    try {
      const res = await fetch(url, { credentials: "omit" });
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const header = (res.headers.get("content-type") || "").split(";")[0].trim();
      const type = C.sniffImageType(bytes) || (header.startsWith("image/") ? header : "");
      return type ? { type, base64: C.bytesToBase64(bytes) } : null;
    } catch {
      return null;
    }
  }

  /** { type, base64 } or null */
  async function getImage(url) {
    return (await viaWorker(url)) || (await direct(url));
  }

  async function pool(items, size, fn) {
    let next = 0;
    const run = async () => {
      while (next < items.length) await fn(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  }

  async function canvasPng(draw, w, h) {
    const canvas = new OffscreenCanvas(w, h);
    draw(canvas.getContext("2d"));
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function toPng(img) {
    const bytes = C.base64ToBytes(img.base64);
    if (img.type === "image/png") return bytes;
    const bmp = await createImageBitmap(new Blob([bytes], { type: img.type }));
    const scale = Math.min(1, MAX_AVATAR_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const png = await canvasPng((ctx) => ctx.drawImage(bmp, 0, 0, w, h), w, h);
    bmp.close();
    return png;
  }

  function placeholderPng(name) {
    const w = 400;
    const h = 600;
    return canvasPng(
      (ctx) => {
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, "#3b3f5c");
        g.addColorStop(1, "#1d1f2e");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#e8e8f0";
        ctx.font = "bold 180px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(([...String(name || "?").trim()][0] || "?").toUpperCase(), w / 2, h / 2);
      },
      w,
      h,
    );
  }

  // ------------------------------------------------------------ extract --

  async function readLorebooks(detail, progress) {
    const scripts = (Array.isArray(detail.scripts) ? detail.scripts : []).filter(
      (s) => s && typeof s === "object" && (s.type === "lorebook" || (!s.type && (s.script || s.entries))),
    );
    const books = [];
    let unreadable = 0;
    for (let i = 0; i < scripts.length; i++) {
      const s = scripts[i];
      progress("Reading lorebook " + (i + 1) + "/" + scripts.length + "…");
      let script = s.script ?? s.entries ?? null;
      let settings = s.settings;
      let title = s.title || s.name || "";
      if (!C.parseScript(script)) {
        const path =
          typeof s.api_path === "string" && /^\/hampter\/script\/[\w-]+$/.test(s.api_path)
            ? s.api_path
            : typeof s.id === "string" && /^[\w-]+$/.test(s.id)
              ? "/hampter/script/" + encodeURIComponent(s.id)
              : null;
        if (path) {
          try {
            const full = await getJson(path);
            script = full && (full.script ?? full.entries ?? null);
            settings = settings || (full && full.settings);
            title = title || (full && full.title) || "";
          } catch {
            script = null;
          }
        }
      }
      if (C.parseScript(script)) books.push({ title, description: s.description, script, settings });
      else unreadable++;
    }
    return { books, unreadable };
  }

  async function embedDescriptionImages(html, progress) {
    const refs = C.findImages(html, location.origin + "/");
    const byUrl = new Map();
    for (const r of refs) {
      if (!byUrl.has(r.url)) byUrl.set(r.url, []);
      byUrl.get(r.url).push(r.raw);
    }
    const urls = [...byUrl.keys()];
    const swaps = new Map();
    let done = 0;
    let failed = 0;
    if (urls.length) progress("Downloading images 0/" + urls.length + "…");
    await pool(urls, 4, async (url) => {
      const img = await getImage(url);
      if (img) for (const raw of byUrl.get(url)) swaps.set(raw, "data:" + img.type + ";base64," + img.base64);
      else failed++;
      progress("Downloading images " + ++done + "/" + urls.length + "…");
    });
    return { html: C.replaceImages(html, swaps), embedded: urls.length - failed, failed };
  }

  async function extract(id, progress) {
    progress("Reading character…");
    const detail = await getJson("/hampter/characters/" + encodeURIComponent(id));
    if (!detail || typeof detail !== "object" || (!detail.name && !detail.chat_name)) {
      throw new ApiError("unexpected response");
    }
    const warnings = [];

    const lore = await readLorebooks(detail, progress);
    if (lore.unreadable)
      warnings.push(
        lore.unreadable === 1
          ? "1 lorebook is private or unreadable and was skipped."
          : lore.unreadable + " lorebooks are private or unreadable and were skipped.",
      );

    // The bot page description: HTML (often mixed with Markdown) -> Markdown, easier to edit.
    let notesIn = C.cleanText(C.decodeEntities(detail.description));
    try {
      notesIn = C.htmlToMarkdown(notesIn);
    } catch {
      warnings.push("The description couldn't be converted to Markdown, so it was kept as HTML.");
    }
    const creatorName = C.decodeEntities(detail.creator_name).trim();
    const notesMark = C.stripWatermark(notesIn, creatorName, true);
    const notes = await embedDescriptionImages(notesMark.text, progress);
    if (notes.failed)
      warnings.push(
        notes.failed +
          (notes.failed === 1 ? " description image" : " description images") +
          " couldn't be downloaded; the original link was kept.",
      );

    const cards = C.buildCards({
      detail,
      books: lore.books,
      creatorNotes: notes.html,
      pageUrl: location.origin + location.pathname,
    });
    const card = cards.v2;
    if (!card.data.description)
      warnings.push("The creator hid this bot's definition, so the card has no description for the AI.");

    progress("Building card…");
    let png = null;
    for (const url of C.avatarUrls(detail)) {
      const img = await getImage(url);
      if (!img) continue;
      try {
        png = await toPng(img);
        break;
      } catch {}
    }
    if (!png) {
      warnings.push("The avatar couldn't be downloaded, so the card uses a placeholder picture.");
      png = await placeholderPng(cards.name);
    }

    const bytes = C.writeCardPng(png, cards);
    const lorebookEntries = card.data.character_book ? card.data.character_book.entries.length : 0;
    const greetings = (card.data.first_mes ? 1 : 0) + card.data.alternate_greetings.length;
    return {
      filename: C.safeFilename(cards.title) + ".png",
      bytes,
      names: cards.title === cards.name ? cards.name : "Title: " + cards.title + "\nIn chat: " + cards.name,
      summary: [
        plural(greetings, "greeting"),
        plural(lorebookEntries, "lorebook entry", "lorebook entries"),
        plural(notes.embedded, "image"),
      ].join(" · ") +
        (cards.watermarks + notesMark.removed
          ? "\n" + plural(cards.watermarks + notesMark.removed, "JanitorAI watermark") + " removed"
          : ""),
      warnings,
    };
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many || one + "s");
  }

  function save(filename, bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    ui.root.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ----------------------------------------------------------------- ui --

  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    button { appearance: none; border: 0; cursor: pointer; font: inherit; font-weight: 600;
      color: #fff; background: #6d5dfc; padding: 10px 18px; border-radius: 999px;
      box-shadow: 0 4px 14px rgba(0,0,0,.35); transition: background .15s, transform .05s; }
    button:hover { background: #5a49f0; }
    button:active { transform: translateY(1px); }
    button:disabled { cursor: progress; background: #4b4a63; }
    button.ok { background: #1f9d63; }
    button.err { background: #c2414b; }
    .status { max-width: 320px; padding: 10px 12px; border-radius: 10px; color: #e9e9f2;
      background: rgba(24,24,32,.96); box-shadow: 0 4px 14px rgba(0,0,0,.35);
      white-space: pre-line; cursor: default; }
    .status[hidden] { display: none; }
    .status .warn { color: #ffcf70; }
    .status .bad { color: #ff9aa2; }
  `;

  const ui = (() => {
    const host = document.createElement("div");
    host.id = "jcx-extract";
    const root = host.attachShadow({ mode: "closed" });
    // Constructed sheets aren't subject to the page's style-src CSP; the
    // <style> element is a fallback for browsers without them.
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {}
    const style = document.createElement("style");
    style.textContent = CSS;
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const status = document.createElement("div");
    status.className = "status";
    status.hidden = true;
    status.setAttribute("role", "status");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Extract";
    button.title = "Save this character as a PNG card";
    wrap.append(status, button);
    root.append(style, wrap);
    return { host, root, status, button };
  })();

  let hideTimer = 0;
  let resetTimer = 0;

  function showStatus(lines, sticky) {
    clearTimeout(hideTimer);
    ui.status.textContent = "";
    for (const [i, line] of lines.entries()) {
      const div = document.createElement("div");
      if (line.kind) div.className = line.kind;
      div.textContent = line.text;
      if (i) div.style.marginTop = "6px";
      ui.status.append(div);
    }
    ui.status.hidden = !lines.length;
    if (!sticky && lines.length) hideTimer = setTimeout(() => (ui.status.hidden = true), 12000);
  }

  function setButton(text, cls) {
    ui.button.textContent = text;
    ui.button.className = cls || "";
  }

  ui.status.addEventListener("click", () => (ui.status.hidden = true));

  ui.button.addEventListener("click", async () => {
    const id = C.characterIdFromPath(location.pathname);
    if (!id || ui.button.disabled) return;
    clearTimeout(resetTimer);
    ui.button.disabled = true;
    setButton("Extracting…");
    showStatus([], true);
    try {
      if (!chrome.runtime || !chrome.runtime.id) throw new ApiError("context");
      const out = await extract(id, (text) => showStatus([{ text }], true));
      save(out.filename, out.bytes);
      setButton("Saved ✓", "ok");
      showStatus([
        { text: "Saved " + out.filename + "\n" + out.names + "\n" + out.summary },
        ...out.warnings.map((text) => ({ text, kind: "warn" })),
      ]);
    } catch (e) {
      setButton("Failed", "err");
      showStatus([{ text: friendlyError(e), kind: "bad" }]);
    } finally {
      ui.button.disabled = false;
      resetTimer = setTimeout(() => setButton("Extract"), 3000);
    }
  });

  // JanitorAI is a single-page app: show the button only on character pages.
  function sync() {
    const onCharacter = !!C.characterIdFromPath(location.pathname);
    if (onCharacter && !ui.host.isConnected) document.documentElement.appendChild(ui.host);
    if (!onCharacter && ui.host.isConnected && !ui.button.disabled) {
      ui.host.remove();
      ui.status.hidden = true;
    }
  }
  sync();
  setInterval(sync, 800);
})();
