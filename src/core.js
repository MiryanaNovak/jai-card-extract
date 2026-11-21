/*
 * Pure logic: turns a JanitorAI character payload into a Character Card V2,
 * and writes that card into a PNG. No DOM, no network, so it runs in the
 * content script, the background worker and Node tests alike.
 */
(function () {
  "use strict";

  const JANITOR_ORIGIN = "https://janitorai.com";
  const AVATAR_BASE = "https://ella.janitorai.com/bot-avatars/";

  // ---------------------------------------------------------------- text --

  const str = (v) => (typeof v === "string" ? v : "");

  /** Line endings to \n, trailing spaces on the whole string trimmed. */
  function cleanText(v) {
    return str(v).replace(/\r\n?/g, "\n").trim();
  }

  /** JanitorAI HTML-escapes some fields (name, public description, tags). */
  function decodeEntities(v) {
    const s = str(v);
    if (s.indexOf("&") === -1) return s;
    const named = { lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", amp: "&" };
    return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|nbsp|amp);/gi, (m, code) => {
      const c = code.toLowerCase();
      if (c[0] === "#") {
        const n = c[1] === "x" ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return named[c];
    });
  }

  /**
   * Comparison key for greetings. JanitorAI pads first_messages with blank or
   * invisible-character entries, and the copy of the main greeting inside
   * first_messages is not always byte-identical to first_message (stray
   * whitespace, NBSPs, zero-width characters), which is how the same greeting
   * ended up imported twice.
   */
  function greetingKey(v) {
    return str(v)
      .normalize("NFKC")
      .replace(/[\p{Cf}­]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  const hasContent = (v) => /[\p{L}\p{N}]/u.test(str(v));

  // ------------------------------------------------------------ watermark --
  // JanitorAI appends a line such as "Created by someone 2026© on jani.com"
  // to the end of the definition fields it serves (personality, scenario,
  // greetings...). It isn't part of the bot, and because it is added to
  // first_message but not to its copy in first_messages, it also made the
  // first greeting look like two different greetings.

  const WM_DOMAIN = /jani(?:torai)?\s*\.\s*(?:com|ai|app|co|net|org)\b|janitor\s*ai\b/i;
  const WM_TRIGGER = /(?:created|made|written|crafted|uploaded|posted)\s+by\b|©|\(c\)|copyright\b/gi;
  const WM_LINE_START =
    /^(?:(?:created|made|written|crafted|uploaded|posted)\s+by\b|©|\(c\)|copyright\b|(?:19|20)\d\d\s*©|jani(?:torai)?\s*\.)/i;
  const WM_WRAPPERS = /^[\s\-–—|•·*_~>#[\](){}"'«»]*/;
  const WM_MAX = 200;

  /** The line without invisible format characters, and where each kept character came from. */
  function visible(line) {
    let text = "";
    const from = [];
    for (let i = 0; i < line.length; ) {
      const ch = String.fromCodePoint(line.codePointAt(i));
      if (!/[\p{Cf}­]/u.test(ch)) {
        text += ch;
        for (let k = 0; k < ch.length; k++) from.push(i + k);
      }
      i += ch.length;
    }
    from.push(line.length);
    return { text, from };
  }

  /** Index in `line` where a trailing watermark starts, or -1. */
  function watermarkStart(line, creator, requireDomain) {
    const { text, from } = visible(line);
    const lower = text.toLowerCase();
    const who = str(creator).trim().toLowerCase();
    const namesCreator = who.length >= 2 && lower.includes(who);

    // The whole line is the watermark: it starts with "Created by", "©", "2026©" or the domain.
    const lead = text.match(WM_WRAPPERS)[0].length;
    const rest = text.slice(lead);
    if (
      rest.length <= WM_MAX &&
      WM_LINE_START.test(rest) &&
      (WM_DOMAIN.test(rest) || (!requireDomain && namesCreator))
    ) {
      return 0;
    }

    // Appended to the last sentence: "...she smiles. Created by X 2026© on jani.com"
    for (const m of text.matchAll(WM_TRIGGER)) {
      const tail = text.slice(m.index);
      if (tail.length > WM_MAX || !WM_DOMAIN.test(tail)) continue;
      let start = m.index;
      while (start > 0 && /[\s\-–—|•·]/.test(text[start - 1])) start--;
      return from[start];
    }
    return -1;
  }

  /**
   * Remove JanitorAI's watermark from the end of a text. With requireDomain,
   * only lines naming JanitorAI's site go (the public description may end
   * with the creator's own signature, which is worth keeping there).
   * Returns { text, removed }.
   */
  function stripWatermark(value, creator, requireDomain) {
    const original = str(value);
    let s = original;
    let removed = 0;
    for (let round = 0; round < 3; round++) {
      s = s.replace(/\s+$/, "");
      const cut = s.lastIndexOf("\n") + 1;
      const line = s.slice(cut);
      const at = watermarkStart(line, creator, requireDomain);
      if (at < 0) break;
      let kept = line.slice(0, at).replace(/\s+$/, "");
      // An opening "**", "(" or "[" left hanging by the cut goes too ("*She smiles.*" keeps its "*").
      kept = kept.replace(/(^|\s)[*_~([]+$/, "$1").replace(/\s+$/, "");
      s = s.slice(0, cut) + kept;
      removed++;
    }
    return removed ? { text: s.replace(/\s+$/, ""), removed } : { text: original, removed: 0 };
  }

  function collectGreetings(detail, clean = cleanText) {
    const raw = [detail.first_message];
    for (const g of Array.isArray(detail.first_messages) ? detail.first_messages : []) {
      raw.push(typeof g === "string" ? g : g && (g.first_message || g.message || g.content));
    }
    const seen = new Set();
    const out = [];
    for (const g of raw) {
      const text = clean(g);
      if (!hasContent(text)) continue;
      const key = greetingKey(text);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return { first: out[0] || "", alternates: out.slice(1) };
  }

  function tagNames(detail) {
    const all = []
      .concat(Array.isArray(detail.tags) ? detail.tags : [])
      .concat(Array.isArray(detail.custom_tags) ? detail.custom_tags : []);
    const seen = new Set();
    const out = [];
    for (const t of all) {
      const name = decodeEntities(typeof t === "string" ? t : t && t.name).trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  }

  // --------------------------------------------------------------- images --

  function absoluteUrl(raw, base) {
    const v = decodeEntities(str(raw)).trim();
    if (!v || /^(data|blob|javascript):/i.test(v)) return null;
    try {
      const u = new URL(v, base || JANITOR_ORIGIN + "/");
      return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
    } catch {
      return null;
    }
  }

  function avatarUrls(detail) {
    const out = [];
    for (const v of [detail.raw_avatar, detail.avatar]) {
      const s = str(v).trim();
      if (!s) continue;
      const url = /^https?:\/\//i.test(s) ? s : AVATAR_BASE + s.replace(/^\/+/, "");
      if (!out.includes(url)) out.push(url);
    }
    return out;
  }

  // Image references we know how to find (and later swap) in a description.
  const IMG_TAG = /<img\b[^>]*>/gi;
  const ATTR = /(\s(?:src|data-src)\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  const MD_IMG =
    /(!\[[^\]]*\]\(\s*)(<[^>\n]+>|(?:[^\s()]|\([^\s()]*\))+)((?:\s+(?:"[^"]*"|'[^']*'))?\s*\))/g;
  const CSS_URL = /(url\(\s*)(["']?)([^"')\s]+)\2(\s*\))/gi;

  function stripAngles(v) {
    return v[0] === "<" && v[v.length - 1] === ">" ? v.slice(1, -1) : v;
  }

  /** Every image reference in the text: [{ raw, url }], unique by raw. */
  function findImages(text, base) {
    const s = str(text);
    const found = new Map();
    const add = (raw) => {
      const url = absoluteUrl(raw, base);
      if (url && !found.has(raw)) found.set(raw, url);
    };
    for (const tag of s.match(IMG_TAG) || []) {
      for (const m of tag.matchAll(ATTR)) add(m[3] ?? m[4] ?? m[5]);
    }
    for (const m of s.matchAll(MD_IMG)) add(stripAngles(m[2]));
    for (const m of s.matchAll(CSS_URL)) add(m[3]);
    return [...found].map(([raw, url]) => ({ raw, url }));
  }

  /** Replace each found reference with replacements.get(raw), where present. */
  function replaceImages(text, replacements) {
    const sub = (raw) => replacements.get(raw);
    return str(text)
      .replace(IMG_TAG, (tag) =>
        tag.replace(ATTR, (m, lead, _q, dq, sq, bare) => {
          const raw = dq ?? sq ?? bare;
          const to = sub(raw);
          return to ? lead + '"' + to + '"' : m;
        }),
      )
      .replace(MD_IMG, (m, lead, target, tail) => {
        const to = sub(stripAngles(target));
        return to ? lead + to + tail : m;
      })
      .replace(CSS_URL, (m, lead, q, raw, tail) => {
        const to = sub(raw);
        return to ? lead + q + to + q + tail : m;
      });
  }

  function sniffImageType(bytes) {
    const b = bytes;
    if (!b || b.length < 12) return "";
    const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
    if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
    if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
    if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
    if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
    if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73)))
      return "image/avif";
    if (at(0, 0x42, 0x4d)) return "image/bmp";
    const head = String.fromCharCode(...b.slice(0, 256)).trimStart().toLowerCase();
    if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
    return "";
  }

  // ------------------------------------------------------------ lorebooks --

  function list(v) {
    if (Array.isArray(v)) return v.map((x) => str(x).trim()).filter(Boolean);
    if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter(Boolean);
    return [];
  }

  function uniq(a) {
    return [...new Set(a)];
  }

  /** One JanitorAI script entry -> one V2 character_book entry (or null). */
  function loreEntry(e, index, clean = cleanText) {
    if (!e || typeof e !== "object") return null;
    const content = clean(e.content ?? e.entry ?? e.text);
    if (!content) return null;
    const keys = uniq([...list(e.keys), ...list(e.key), ...list(e.keywords), ...list(e.keysRaw)]);
    const secondary = uniq([
      ...list(e.secondary_keys),
      ...list(e.keysecondary),
      ...list(e.secondaryKeys),
      ...list(e.secondaryKeysRaw),
    ]);
    const name = str(e.name || e.comment || e.title).trim();
    const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    return {
      keys,
      secondary_keys: secondary,
      content,
      extensions: {},
      enabled: e.enabled !== false && e.disable !== true,
      insertion_order: num(e.insertion_order, num(e.order, 100)),
      case_sensitive: e.case_sensitive === true,
      name,
      priority: num(e.priority, 10),
      id: index,
      comment: name,
      selective: secondary.length > 0,
      constant: e.constant === true,
      position: e.position === "after_char" ? "after_char" : "before_char",
    };
  }

  /** Parse a script payload (string or array or {entries}) into entries. */
  function parseScript(script) {
    let v = script;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        return null;
      }
    }
    if (v && !Array.isArray(v) && typeof v === "object") {
      v = Array.isArray(v.entries) ? v.entries : v.entries && typeof v.entries === "object" ? Object.values(v.entries) : null;
    }
    return Array.isArray(v) ? v : null;
  }

  function scanDepth(settings) {
    let s = settings;
    if (typeof s === "string") {
      try {
        s = JSON.parse(s);
      } catch {
        return undefined;
      }
    }
    return s && typeof s.depth === "number" ? s.depth : undefined;
  }

  /**
   * books: [{ title, description, script, settings }] -> V2 character_book or
   * undefined. One book keeps its own JanitorAI name; several are merged into
   * one (a card holds a single book) named "<bot title> lorebook".
   */
  function characterBook(books, ownerName, clean) {
    const entries = [];
    const titles = [];
    let depth;
    for (const book of books || []) {
      const raw = parseScript(book.script);
      if (!raw) continue;
      const before = entries.length;
      for (const e of raw) {
        const entry = loreEntry(e, entries.length, clean);
        if (entry) entries.push(entry);
      }
      if (entries.length > before) {
        titles.push(decodeEntities(book.title).trim() || "Lorebook");
        if (depth === undefined) depth = scanDepth(book.settings);
      }
    }
    if (!entries.length) return undefined;
    const book = {
      name: titles.length === 1 ? titles[0] : (ownerName || "Character") + " lorebook",
      description: titles.length > 1 ? "Merged from: " + titles.join(", ") : "",
      recursive_scanning: false,
      extensions: {},
      entries,
    };
    if (depth !== undefined) book.scan_depth = depth;
    return book;
  }

  // ---------------------------------------------------------------- card --

  /**
   * A JanitorAI bot has two names:
   *   name      the title shown on its page, for people only ("Aveline | the archivist")
   *   chat_name the character's name, what {{char}} stands for ("Aveline")
   *
   * V3 holds both: `name` is the title and `nickname` the in-chat name. V2 has
   * a single name, which apps use for {{char}}, so it gets the in-chat name.
   *
   * detail:       /hampter/characters/{id} payload
   * books:        lorebooks [{ title, description, script, settings }]
   * creatorNotes: the public description, decoded, images already embedded
   * Returns { v2, v3, title, name, watermarks } (watermarks: how many were removed).
   */
  function buildCards({ detail, books, creatorNotes, pageUrl }) {
    const d = detail && typeof detail === "object" ? detail : {};
    const chatName = decodeEntities(d.chat_name).trim();
    const title = decodeEntities(d.name).trim() || chatName || "Character";
    const name = chatName || title;
    const creator = decodeEntities(d.creator_name).trim();
    let watermarks = 0;
    const clean = (v) => {
      const r = stripWatermark(cleanText(v), creator);
      watermarks += r.removed;
      return r.text;
    };
    const definition = clean(d.personality);
    const greetings = collectGreetings(d, clean);
    const book = characterBook(books, title, clean);
    const url = pageUrl || (d.id ? JANITOR_ORIGIN + "/characters/" + d.id : undefined);

    const janitor = {
      id: str(d.id) || undefined,
      url,
      title: title !== name ? title : undefined,
      creator_id: str(d.creator_id) || undefined,
      nsfw: typeof d.is_nsfw === "boolean" ? d.is_nsfw : undefined,
      definition_hidden: !definition || undefined,
    };

    const v2 = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        // JanitorAI's "personality" is the character definition the AI reads.
        description: definition,
        personality: "",
        scenario: clean(d.scenario),
        first_mes: greetings.first,
        mes_example: clean(d.example_dialogs),
        // JanitorAI's "description" is the public bot page, meant for people.
        creator_notes: creatorNotes != null ? creatorNotes : cleanText(decodeEntities(d.description)),
        system_prompt: "",
        post_history_instructions: "",
        alternate_greetings: greetings.alternates,
        tags: tagNames(d),
        creator,
        character_version: "",
        extensions: { janitorai: JSON.parse(JSON.stringify(janitor)) },
        ...(book ? { character_book: book } : {}),
      },
    };

    const v3data = JSON.parse(JSON.stringify(v2.data));
    v3data.name = title;
    if (name !== title) v3data.nickname = name;
    v3data.group_only_greetings = [];
    if (url) v3data.source = [url];
    if (v3data.character_book) {
      for (const e of v3data.character_book.entries) e.use_regex = false;
    }
    const v3 = { spec: "chara_card_v3", spec_version: "3.0", data: v3data };

    return { v2, v3, title, name, watermarks };
  }

  function characterIdFromPath(pathname) {
    const m = str(pathname).match(/\/characters\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? m[1].toLowerCase() : null;
  }

  function safeFilename(name) {
    const base = str(name)
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s.]+|[\s.]+$/g, "");
    return [...base].slice(0, 80).join("").trim() || "character";
  }

  // ----------------------------------------------------------------- PNG --

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start, end) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function textKeyword(bytes, start, end) {
    let s = "";
    for (let i = start; i < end && bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function textChunk(keyword, asciiText) {
    const payloadLen = keyword.length + 1 + asciiText.length;
    const chunk = new Uint8Array(12 + payloadLen);
    const cv = new DataView(chunk.buffer);
    cv.setUint32(0, payloadLen);
    chunk.set([0x74, 0x45, 0x58, 0x74], 4); // "tEXt"
    let o = 8;
    for (let i = 0; i < keyword.length; i++) chunk[o++] = keyword.charCodeAt(i);
    chunk[o++] = 0;
    for (let i = 0; i < asciiText.length; i++) chunk[o++] = asciiText.charCodeAt(i) & 0xff;
    cv.setUint32(8 + payloadLen, crc32(chunk, 4, 8 + payloadLen));
    return chunk;
  }

  /**
   * Return a copy of the PNG with one tEXt chunk per [keyword, asciiText]
   * pair, placed before IEND. Any earlier card chunks (chara, ccv3) are
   * dropped so an avatar that was itself a card can't leak a stale definition.
   */
  function pngWithTexts(png, texts) {
    const src = png instanceof Uint8Array ? png : new Uint8Array(png);
    if (!PNG_SIG.every((b, i) => src[i] === b)) throw new Error("not-a-png");
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const drop = new Set(["chara", "ccv3"]);
    const parts = [src.subarray(0, 8)];
    let pos = 8;
    let iend = -1;
    while (pos + 12 <= src.length) {
      const len = view.getUint32(pos);
      const type = String.fromCharCode(src[pos + 4], src[pos + 5], src[pos + 6], src[pos + 7]);
      const next = pos + 12 + len;
      if (next > src.length) throw new Error("truncated-png");
      if (type === "IEND") {
        iend = pos;
        break;
      }
      const isText = type === "tEXt" || type === "iTXt" || type === "zTXt";
      if (!(isText && drop.has(textKeyword(src, pos + 8, pos + 8 + len)))) {
        parts.push(src.subarray(pos, next));
      }
      pos = next;
    }
    if (iend < 0) throw new Error("png-without-iend");
    for (const [keyword, text] of texts) parts.push(textChunk(keyword, text));
    parts.push(src.subarray(iend, iend + 12));

    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let w = 0;
    for (const p of parts) {
      out.set(p, w);
      w += p.length;
    }
    return out;
  }

  function bytesToBase64(bytes) {
    let bin = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const encodeCard = (card) => bytesToBase64(new TextEncoder().encode(JSON.stringify(card)));

  /**
   * The finished card: the avatar PNG with the V2 card in a `chara` chunk and
   * the V3 card in a `ccv3` chunk, each base64(UTF-8 JSON). Apps that know V3
   * read ccv3 (and get both names); the rest read chara.
   */
  function writeCardPng(avatarPng, { v2, v3 }) {
    return pngWithTexts(avatarPng, [
      ["chara", encodeCard(v2)],
      ["ccv3", encodeCard(v3)],
    ]);
  }

  const api = {
    AVATAR_BASE,
    cleanText,
    decodeEntities,
    greetingKey,
    stripWatermark,
    collectGreetings,
    tagNames,
    absoluteUrl,
    avatarUrls,
    findImages,
    replaceImages,
    sniffImageType,
    loreEntry,
    parseScript,
    characterBook,
    buildCards,
    characterIdFromPath,
    safeFilename,
    crc32,
    pngWithTexts,
    bytesToBase64,
    base64ToBytes,
    writeCardPng,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.JCX = api;
})();
