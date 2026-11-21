const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const C = require("../src/core.js");

const detail = () => ({
  id: "0f1e2d3c-4b5a-4968-8776-655443322110",
  name: "Aveline | the archivist",
  chat_name: "Aveline",
  creator_name: "story&amp;weaver",
  avatar: "abc123.webp",
  raw_avatar: "abc123-raw.png",
  is_nsfw: false,
  description:
    "&lt;p&gt;Hi! Art by me.&lt;/p&gt;&lt;img src=&quot;https://ella.janitorai.com/media-approved/one.webp&quot;&gt;" +
    "\n![banner](https://i.imgur.com/two.png)",
  personality: "{{char}} is a royal historian.\r\nQuiet and precise.",
  scenario: "The archive after midnight.",
  first_message: "You are late.",
  first_messages: [null, "​", "You are late. ", "The door is open.", "the door is open."],
  example_dialogs: "{{char}}: Sit down.",
  tags: [{ id: 1, name: "Fantasy" }, { name: "Female" }],
  custom_tags: ["fantasy", "Slow burn"],
  scripts: [],
});

test("AI definition goes to description, public blurb goes to creator_notes", () => {
  const card = C.buildCards({ detail: detail(), books: [] }).v2;
  assert.equal(card.spec, "chara_card_v2");
  assert.equal(card.data.name, "Aveline");
  assert.equal(card.data.description, "{{char}} is a royal historian.\nQuiet and precise.");
  assert.equal(card.data.personality, "");
  assert.match(card.data.creator_notes, /^<p>Hi! Art by me\.<\/p><img src="https:\/\/ella/);
  assert.equal(card.data.creator, "story&weaver");
  assert.equal(card.data.extensions.janitorai.title, "Aveline | the archivist");
});

test("both names: V3 has the title and the in-chat nickname, V2 the in-chat name", () => {
  const { v2, v3, title, name } = C.buildCards({ detail: detail(), books: [] });
  assert.equal(title, "Aveline | the archivist");
  assert.equal(name, "Aveline");
  assert.equal(v2.data.name, "Aveline");
  assert.equal(v3.spec, "chara_card_v3");
  assert.equal(v3.spec_version, "3.0");
  assert.equal(v3.data.name, "Aveline | the archivist");
  assert.equal(v3.data.nickname, "Aveline");
  assert.deepEqual(v3.data.group_only_greetings, []);
  assert.deepEqual(v3.data.source, ["https://janitorai.com/characters/0f1e2d3c-4b5a-4968-8776-655443322110"]);
  assert.equal(v3.data.description, v2.data.description);
  assert.equal(v3.data.creator_notes, v2.data.creator_notes);

  const same = C.buildCards({ detail: { ...detail(), name: "Aveline" }, books: [] });
  assert.equal(same.v3.data.name, "Aveline");
  assert.equal("nickname" in same.v3.data, false);

  const noChatName = C.buildCards({ detail: { ...detail(), chat_name: "" }, books: [] });
  assert.equal(noChatName.v2.data.name, "Aveline | the archivist");
});

test("merged lorebooks are named after the bot title; V3 entries get use_regex", () => {
  const books = [
    { title: "A", script: [{ key: ["a"], content: "A." }] },
    { title: "B", script: [{ key: ["b"], content: "B." }] },
  ];
  const { v2, v3 } = C.buildCards({ detail: detail(), books });
  assert.equal(v2.data.character_book.name, "Aveline | the archivist lorebook");
  assert.equal("use_regex" in v2.data.character_book.entries[0], false);
  assert.equal(v3.data.character_book.entries[0].use_regex, false);
  const single = C.buildCards({ detail: detail(), books: books.slice(0, 1) });
  assert.equal(single.v2.data.character_book.name, "A");
});

test("the first greeting is never repeated as an alternate", () => {
  const card = C.buildCards({ detail: detail(), books: [] }).v2;
  assert.equal(card.data.first_mes, "You are late.");
  assert.deepEqual(card.data.alternate_greetings, ["The door is open."]);

  const nbsp = C.collectGreetings({
    first_message: "*She waves.*\n\n\"Hello!\"",
    first_messages: ["*She waves.*\r\n\r\n\"Hello!\"​", "Second."],
  });
  assert.deepEqual(nbsp.alternates, ["Second."]);

  const onlyList = C.collectGreetings({ first_message: "", first_messages: ["A.", "B."] });
  assert.equal(onlyList.first, "A.");
  assert.deepEqual(onlyList.alternates, ["B."]);
});

test("tags are merged case-insensitively", () => {
  assert.deepEqual(C.tagNames(detail()), ["Fantasy", "Female", "Slow burn"]);
});

test("avatar prefers the original upload", () => {
  assert.deepEqual(C.avatarUrls(detail()), [
    "https://ella.janitorai.com/bot-avatars/abc123-raw.png",
    "https://ella.janitorai.com/bot-avatars/abc123.webp",
  ]);
});

test("finds and replaces images in HTML, markdown and CSS", () => {
  const html = [
    '<img alt="a" src="https://x.test/a.png?w=1&amp;h=2">',
    "<IMG SRC='//cdn.test/b.gif' width=20>",
    "<img data-src=https://x.test/c.webp>",
    "![pic](https://x.test/d_(1).jpg \"title\")",
    "![pic](<https://x.test/e e.png>)",
    '<div style="background:url(\'https://x.test/f.jpg\')"></div>',
    '<a href="https://x.test/a.png?w=1&amp;h=2">link stays</a>',
    '<img src="data:image/png;base64,AAAA">',
  ].join("\n");
  const found = C.findImages(html);
  assert.deepEqual(
    found.map((f) => f.url),
    [
      "https://x.test/a.png?w=1&h=2",
      "https://cdn.test/b.gif",
      "https://x.test/c.webp",
      "https://x.test/d_(1).jpg",
      "https://x.test/e%20e.png",
      "https://x.test/f.jpg",
    ],
  );
  const map = new Map(found.map((f, i) => [f.raw, "data:image/png;base64,IMG" + i]));
  const out = C.replaceImages(html, map);
  assert.ok(out.includes('<img alt="a" src="data:image/png;base64,IMG0">'));
  assert.ok(out.includes('SRC="data:image/png;base64,IMG1" width=20>'));
  assert.ok(out.includes('data-src="data:image/png;base64,IMG2">'));
  assert.ok(out.includes('![pic](data:image/png;base64,IMG3 "title")'));
  assert.ok(out.includes("![pic](data:image/png;base64,IMG4)"));
  assert.ok(out.includes("url('data:image/png;base64,IMG5')"));
  assert.ok(out.includes('<a href="https://x.test/a.png?w=1&amp;h=2">link stays</a>'));
});

test("lorebook entries from every JanitorAI shape", () => {
  const book = C.characterBook(
    [
      {
        title: "Archive",
        settings: JSON.stringify({ depth: 6 }),
        script: JSON.stringify([
          { key: ["archive", "records"], content: "The west archive is locked.", name: "Archive", priority: 5 },
          { keysRaw: "gate, west gate", content: "The gate creaks." },
          { keys: ["empty"], content: "   " },
          { key: [], content: "Always on.", constant: true, enabled: false },
        ]),
      },
      { title: "World", script: [{ keywords: ["moon"], secondary_keys: ["night"], entry: "Two moons." }] },
      { title: "Locked", script: null },
    ],
    "Aveline",
  );
  assert.equal(book.name, "Aveline lorebook");
  assert.equal(book.scan_depth, 6);
  assert.equal(book.entries.length, 4);
  assert.deepEqual(book.entries[0].keys, ["archive", "records"]);
  assert.equal(book.entries[0].comment, "Archive");
  assert.equal(book.entries[0].priority, 5);
  assert.deepEqual(book.entries[1].keys, ["gate", "west gate"]);
  assert.equal(book.entries[2].constant, true);
  assert.equal(book.entries[2].enabled, false);
  assert.equal(book.entries[3].selective, true);
  assert.deepEqual(book.entries[3].secondary_keys, ["night"]);
  assert.deepEqual(book.entries.map((e) => e.id), [0, 1, 2, 3]);
  assert.equal(C.characterBook([{ title: "x", script: "not json" }]), undefined);
});

test("character id and filename helpers", () => {
  assert.equal(
    C.characterIdFromPath("/characters/0F1E2D3C-4b5a-4968-8776-655443322110_character-aveline"),
    "0f1e2d3c-4b5a-4968-8776-655443322110",
  );
  assert.equal(C.characterIdFromPath("/chats/123"), null);
  assert.equal(C.safeFilename('Vox: "the" TV/demon?'), "Vox the TV demon");
  assert.equal(C.safeFilename("..."), "character");
});

function tinyPng() {
  // 1x1 RGBA PNG built by hand so the test has no image dependency.
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, "latin1");
    data.copy(b, 8);
    b.writeUInt32BE(C.crc32(b, 4, 8 + data.length), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  const oldCard = Buffer.concat([Buffer.from("chara\0", "latin1"), Buffer.from("b2xk", "latin1")]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", oldCard),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function readText(png) {
  const out = {};
  let pos = 8;
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("latin1", pos + 4, pos + 8);
    const crc = png.readUInt32BE(pos + 8 + len);
    assert.equal(crc, C.crc32(png, pos + 4, pos + 8 + len), "crc of " + type);
    if (type === "tEXt") {
      const body = png.toString("latin1", pos + 8, pos + 8 + len);
      const i = body.indexOf("\0");
      (out[body.slice(0, i)] = out[body.slice(0, i)] || []).push(body.slice(i + 1));
    }
    pos += 12 + len;
  }
  return out;
}

test("writes one chara (V2) and one ccv3 (V3) chunk with UTF-8 JSON, replacing any old one", () => {
  const cards = C.buildCards({ detail: { ...detail(), name: "Élodie ✨ | la fée", chat_name: "Élodie ✨" }, books: [] });
  const png = Buffer.from(C.writeCardPng(tinyPng(), cards));
  const text = readText(png);
  assert.equal(text.chara.length, 1);
  assert.equal(text.ccv3.length, 1);
  const v2 = JSON.parse(Buffer.from(text.chara[0], "base64").toString("utf8"));
  const v3 = JSON.parse(Buffer.from(text.ccv3[0], "base64").toString("utf8"));
  assert.equal(v2.data.name, "Élodie ✨");
  assert.equal(v3.data.name, "Élodie ✨ | la fée");
  assert.equal(v3.data.nickname, "Élodie ✨");
  assert.equal(png.toString("latin1", png.length - 8, png.length - 4), "IEND");
  assert.throws(() => C.pngWithTexts(new Uint8Array(20), [["chara", "x"]]), /not-a-png/);
});

test("sniffs image types from bytes", () => {
  assert.equal(C.sniffImageType(tinyPng()), "image/png");
  assert.equal(C.sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")), "image/webp");
  assert.equal(C.sniffImageType(Buffer.from("GIF89a......", "latin1")), "image/gif");
  assert.equal(C.sniffImageType(Buffer.from("<!doctype html><html>", "latin1")), "");
});

test("JanitorAI watermarks are removed from the end of a field", () => {
  const strip = (t, req) => C.stripWatermark(t, "storyweaver", req).text;
  const body = "{{char}} is a royal historian.\nQuiet and precise.";
  for (const mark of [
    "Created by storyweaver 2026© on jani.com",
    "created by @storyweaver © 2026 on janitorai.com",
    "**Created by storyweaver on JanitorAI**",
    "— Created by storyweaver, 2026© on jani.com.",
    "© 2026 storyweaver — jani.com",
    "2026© storyweaver on jani.com",
    "Created​ by storyweaver 2026© on jani​.com",
    "[Created by storyweaver 2026© on jani.com](https://jani.com/profiles/x)",
    "Created by storyweaver", // the creator's name alone, at the end of an AI field
  ]) {
    assert.equal(strip(body + "\n" + mark), body, mark);
    assert.equal(strip(body + "\n\n" + mark + "\n"), body, "blank line before: " + mark);
  }
  assert.equal(strip("Created by storyweaver 2026© on jani.com"), "");
});

test("a watermark appended to the last sentence is cut without touching the sentence", () => {
  const strip = (t) => C.stripWatermark(t, "storyweaver").text;
  assert.equal(strip('*She smiles.* "Hello." Created by storyweaver 2026© on jani.com'), '*She smiles.* "Hello."');
  assert.equal(strip("She waits. **Created by storyweaver on janitorai.com**"), "She waits.");
  assert.equal(strip("She waits. | © 2026 storyweaver on jani.com"), "She waits.");
});

test("ordinary text that merely looks similar is left alone", () => {
  const keep = [
    "{{char}} was created by Dr. Vale in a lab.",
    "Made by hand, the sword never dulls.",
    "Her best friend is Jani.",
    "Created by storyweaver", // not at the end
  ];
  for (const t of keep) assert.equal(C.stripWatermark(t + "\nShe smiles.", "storyweaver").removed, 0, t);
  for (const t of keep.slice(0, 3)) assert.equal(C.stripWatermark(t, "storyweaver").text, t, t);
  // In the public description only lines naming JanitorAI's site go: a signature stays.
  assert.equal(C.stripWatermark("Enjoy!\nMade by storyweaver ♡", "storyweaver", true).removed, 0);
  assert.equal(C.stripWatermark("Enjoy!\nCreated by storyweaver 2026© on jani.com", "storyweaver", true).text, "Enjoy!");
});

test("the first greeting isn't doubled when only one copy carries the watermark", () => {
  const { v2, watermarks } = C.buildCards({
    detail: {
      ...detail(),
      creator_name: "storyweaver",
      personality: "Quiet.\n\nCreated by storyweaver 2026© on jani.com",
      scenario: "The archive.\nCreated by storyweaver 2026© on jani.com",
      first_message: "*Aveline looks up.* You are late.\n\nCreated by storyweaver 2026© on jani.com",
      first_messages: ["*Aveline looks up.* You are late.", "The door is open."],
      example_dialogs: "{{char}}: Sit.\nCreated by storyweaver 2026© on jani.com",
    },
    books: [{ title: "A", script: [{ key: ["a"], content: "Lore.\nCreated by storyweaver 2026© on jani.com" }] }],
  });
  assert.equal(v2.data.description, "Quiet.");
  assert.equal(v2.data.scenario, "The archive.");
  assert.equal(v2.data.first_mes, "*Aveline looks up.* You are late.");
  assert.deepEqual(v2.data.alternate_greetings, ["The door is open."]);
  assert.equal(v2.data.mes_example, "{{char}}: Sit.");
  assert.equal(v2.data.character_book.entries[0].content, "Lore.");
  assert.equal(watermarks, 5);
});
