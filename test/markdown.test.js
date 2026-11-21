const test = require("node:test");
const assert = require("node:assert/strict");

// The extension loads the browser build of Turndown; Node needs the one that brings its own DOM.
const toMarkdown = require("../src/markdown.js")(require("turndown"), require("../src/vendor/markdown-it.js"));

test("editor HTML becomes Markdown", () => {
  const html =
    '<p><strong>Created by @storyweaver</strong></p><p>She is <em>quiet</em> and <u>precise</u>.<br>Second line.</p>' +
    '<h2 style="color:red">Rules</h2><ul><li>No <del>spoilers</del></li><li>Be nice</li></ul>' +
    '<blockquote><p>A quote</p></blockquote><hr><p><a href="https://ko-fi.com/x">my ko-fi</a></p>';
  assert.equal(
    toMarkdown(html),
    [
      "**Created by @storyweaver**",
      "",
      "She is *quiet* and precise.",
      "Second line.",
      "",
      "## Rules",
      "",
      "- No ~~spoilers~~",
      "- Be nice",
      "",
      "> A quote",
      "",
      "---",
      "",
      "[my ko-fi](https://ko-fi.com/x)",
    ].join("\n"),
  );
});

test("Markdown mixed with HTML keeps its line breaks and syntax", () => {
  const mixed =
    '<center><img src="https://x.test/banner.png" width="400"></center>\n\n' +
    "**Name:** Aveline\nAge: 25\n\n*She looks up from her book.*\n\n![gif](https://x.test/a.gif)";
  assert.equal(
    toMarkdown(mixed),
    [
      "![image](https://x.test/banner.png)",
      "",
      "**Name:** Aveline",
      "Age: 25",
      "",
      "*She looks up from her book.*",
      "",
      "![gif](https://x.test/a.gif)",
    ].join("\n"),
  );
});

test("text is not backslash-escaped", () => {
  assert.equal(toMarkdown("<p>my_user_name loves *tea* & [brackets] #1</p>"), "my_user_name loves *tea* & [brackets] #1");
});

test("CSS, scripts and styling are dropped; indented HTML is not a code block", () => {
  const html = [
    "<style>.card{background:url(https://x.test/bg.png)} p{color:pink}</style>",
    '<div class="card" style="text-align:center;font-family:serif">',
    "",
    '    <p><span style="color:#f0a">Pink words</span></p>',
    "",
    "</div>",
    "<script>alert(1)</script>",
  ].join("\n");
  assert.equal(toMarkdown(html), "Pink words");
});

test("background images and empty decorative divs keep their pictures", () => {
  const html =
    "<div style=\"background-image:url('https://x.test/bg.jpg');height:200px\"></div>" +
    '<div style="background: url(https://x.test/frame.png) no-repeat"><p>Framed text</p></div>';
  assert.equal(toMarkdown(html), "![image](https://x.test/bg.jpg)\n\n![image](https://x.test/frame.png)\n\nFramed text");
});

test("tables: header row, header-less layout tables, one-column frames", () => {
  const headed = "<table><tr><th>Stat</th><th>Value</th></tr><tr><td>Age</td><td>25 | ish</td></tr></table>";
  assert.equal(toMarkdown(headed), "| Stat | Value |\n| --- | --- |\n| Age | 25 \\| ish |");

  const layout =
    '<table><tr><td><img src="https://x.test/a.png"></td><td><img src="https://x.test/b.png"></td></tr></table>';
  assert.equal(toMarkdown(layout), "|  |  |\n| --- | --- |\n| ![image](https://x.test/a.png) | ![image](https://x.test/b.png) |");

  const frame = '<table><tr><td><p>One</p><p>Two</p></td></tr><tr><td><img src="https://x.test/c.png"></td></tr></table>';
  assert.equal(toMarkdown(frame), "One\n\nTwo\n\n![image](https://x.test/c.png)");
});

test("embeds become links, details keep their summary, odd URLs stay valid", () => {
  const html =
    '<iframe src="https://www.youtube.com/embed/abc"></iframe>' +
    '<audio controls><source src="https://x.test/theme.mp3"></audio>' +
    "<details><summary>Spoilers</summary><p>Hidden text</p></details>" +
    '<img alt="my [cool] pic" src="https://x.test/a b (1).png">';
  assert.equal(
    toMarkdown(html),
    [
      "[Embedded content](https://www.youtube.com/embed/abc)",
      "",
      "[Audio](https://x.test/theme.mp3)",
      "",
      "**Spoilers**",
      "",
      "Hidden text",
      "",
      "![my cool pic](https://x.test/a%20b%20%281%29.png)",
    ].join("\n"),
  );
});

test("lists: ordered with start, nested", () => {
  const html = '<ol start="3"><li>Three</li><li>Four<ul><li>Sub</li></ul></li></ol>';
  assert.equal(toMarkdown(html), "3. Three\n4. Four\n    - Sub");
  // JanitorAI's editor wraps each item in <p>: still a tight list
  assert.equal(toMarkdown("<ul><li><p>One</p></li><li><p>Two</p></li></ul><p>After</p>"), "- One\n- Two\n\nAfter");
});

test("empty input stays empty", () => {
  assert.equal(toMarkdown(""), "");
  assert.equal(toMarkdown("   \n "), "");
});
