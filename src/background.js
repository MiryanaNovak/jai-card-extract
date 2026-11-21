/*
 * Downloads images for the content script. Bot descriptions link images on
 * many hosts (JanitorAI's CDN, imgur, catbox...), and a page script can't read
 * most of them because of CORS. The extension worker can, thanks to the host
 * permission. It only ever fetches http(s) URLs it is handed by this
 * extension's own content script, and only returns bytes that look like an
 * image.
 */
importScripts("core.js");

const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 30000;

async function fetchImage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: "bad-url" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "bad-url" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const sameSite = /(^|\.)(janitorai|jani)\.com$/i.test(u.hostname);
    const res = await fetch(u.href, {
      credentials: sameSite ? "include" : "omit",
      referrerPolicy: "no-referrer",
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: "http-" + res.status };
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) return { ok: false, error: "too-large" };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { ok: false, error: "too-large" };
    const header = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const type = JCX.sniffImageType(bytes) || (header.startsWith("image/") ? header : "");
    if (!type) return { ok: false, error: "not-an-image" };
    return { ok: true, type, base64: JCX.bytesToBase64(bytes) };
  } catch (e) {
    return { ok: false, error: e && e.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !msg || msg.type !== "jcx:image") return false;
  fetchImage(String(msg.url)).then(reply);
  return true;
});
