/*
 * Bot page description (HTML, often mixed with Markdown) -> plain Markdown.
 *
 * Two steps, so mixed input comes out right:
 *   1. markdown-it renders it as a Markdown renderer would (raw HTML passes
 *      through, Markdown syntax and line breaks become HTML);
 *   2. Turndown turns that HTML into clean Markdown.
 *
 * What Markdown can't hold (colors, fonts, alignment, CSS) is dropped. Images
 * are kept, including CSS background images, and embeds become links.
 */
(function () {
  "use strict";

  function create(TurndownService, markdownit) {
    const md = markdownit({ html: true, breaks: true, linkify: false, typographer: false });
    // Descriptions are hand-indented HTML, not code: 4 spaces mustn't make a code block.
    md.disable(["code"]);

    const BACKGROUND_TAGS = new Set([
      "DIV", "SECTION", "SPAN", "P", "CENTER", "HEADER", "FOOTER", "ARTICLE", "ASIDE",
      "MAIN", "FIGURE", "BLOCKQUOTE", "BODY",
    ]);

    const td = new TurndownService({
      headingStyle: "atx",
      hr: "---",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
      strongDelimiter: "**",
      linkStyle: "inlined",
      br: "", // a plain newline: apps render descriptions with line breaks on
      // An empty <div> can still carry a background picture.
      blankReplacement: (_c, node) => {
        const bg = BACKGROUND_TAGS.has(node.nodeName) ? backgroundUrls(node) : [];
        if (bg.length) return "\n\n" + imagesFor(bg) + "\n\n";
        return node.isBlock ? "\n\n" : "";
      },
    });
    // Leave text as written: escaping would litter names_like_this and *actions* with backslashes.
    td.escape = (s) => s;
    td.remove(["style", "script", "noscript", "template", "title", "meta", "link", "head", "button", "select", "textarea"]);

    const attr = (node, name) => (node.getAttribute && node.getAttribute(name)) || "";
    const mdUrl = (u) =>
      String(u)
        .trim()
        .replace(/\s/g, (c) => encodeURIComponent(c))
        .replace(/[()<>]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    const altText = (s) => String(s || "").replace(/[\[\]\s]+/g, " ").trim();
    const isUsableUrl = (u) => /^(https?:)?\/\//i.test(u) || /^data:image\//i.test(u);

    function backgroundUrls(node) {
      const out = [];
      const style = attr(node, "style");
      for (const m of style.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
        if (isUsableUrl(m[2].trim())) out.push(m[2].trim());
      }
      return out;
    }
    // Never an empty alt: some apps' cleanup takes "[](...)" for an empty link and breaks "![](...)".
    const imagesFor = (urls) => urls.map((u) => "![image](" + mdUrl(u) + ")").join("\n");

    td.addRule("image", {
      filter: "img",
      replacement(_c, node) {
        const src = attr(node, "src") || attr(node, "data-src");
        return src ? "![" + (altText(attr(node, "alt")) || "image") + "](" + mdUrl(src) + ")" : "";
      },
    });

    td.addRule("link", {
      filter: (node) => node.nodeName === "A" && attr(node, "href"),
      replacement(content, node) {
        const href = attr(node, "href").trim();
        if (!content.trim()) return "";
        if (/^(javascript|data):/i.test(href) || href.startsWith("#")) return content;
        return "[" + content + "](" + mdUrl(href) + ")";
      },
    });

    td.addRule("strike", {
      filter: ["del", "s", "strike"],
      replacement: (content) => (content.trim() ? "~~" + content + "~~" : content),
    });

    td.addRule("checkbox", {
      filter: (node) => node.nodeName === "INPUT",
      replacement: (_c, node) =>
        attr(node, "type").toLowerCase() === "checkbox" ? (node.hasAttribute("checked") ? "[x] " : "[ ] ") : "",
    });

    td.addRule("media", {
      filter: ["iframe", "video", "audio", "embed", "object"],
      replacement(_c, node) {
        let src = attr(node, "src") || attr(node, "data");
        if (!src && node.querySelector) {
          const source = node.querySelector("source[src]");
          if (source) src = attr(source, "src");
        }
        if (!src || !isUsableUrl(src)) return "";
        const label = node.nodeName === "AUDIO" ? "Audio" : node.nodeName === "VIDEO" ? "Video" : "Embedded content";
        return "\n\n[" + label + "](" + mdUrl(src) + ")\n\n";
      },
    });

    // "- item" / "1. item" rather than Turndown's "-   item": easier to edit.
    td.addRule("listItem", {
      filter: "li",
      replacement(content, node) {
        content = content.replace(/^\n+/, "").replace(/\n+$/, "").replace(/\n/g, "\n    ");
        let prefix = "- ";
        const parent = node.parentNode;
        if (parent && parent.nodeName === "OL") {
          const start = parseInt(attr(parent, "start"), 10);
          const index = Array.prototype.indexOf.call(parent.children, node);
          prefix = (Number.isFinite(start) ? start + index : index + 1) + ". ";
        }
        return prefix + content + (node.nextSibling ? "\n" : "");
      },
    });

    td.addRule("summary", {
      filter: "summary",
      replacement: (content) => (content.trim() ? "\n\n**" + content.trim() + "**\n\n" : ""),
    });

    // Rows of a table (not of tables nested inside it).
    function rowsOf(table) {
      const rows = [];
      for (const child of Array.from(table.children)) {
        if (child.nodeName === "TR") rows.push(child);
        else if (/^(THEAD|TBODY|TFOOT)$/.test(child.nodeName)) {
          for (const tr of Array.from(child.children)) if (tr.nodeName === "TR") rows.push(tr);
        }
      }
      return rows;
    }

    td.addRule("table", {
      filter: "table",
      replacement(_c, table) {
        const rows = rowsOf(table).map((tr) => Array.from(tr.children).filter((c) => c.nodeName === "TD" || c.nodeName === "TH"));
        const bg = backgroundUrls(table);
        for (const row of rows) for (const cell of row) bg.push(...backgroundUrls(cell));
        const cellText = (cell) => convert(cell.innerHTML);
        const width = Math.max(0, ...rows.map((r) => r.length));
        let body;
        if (width <= 1) {
          // A one-column table is a layout frame: just its contents.
          body = rows.map((r) => (r[0] ? cellText(r[0]) : "")).filter(Boolean).join("\n\n");
        } else {
          const line = (cells) =>
            "| " +
            Array.from({ length: width }, (_, i) =>
              cells[i] ? cellText(cells[i]).replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|") : "",
            ).join(" | ") +
            " |";
          const headed = rows.length > 1 && rows[0].every((c) => c.nodeName === "TH");
          const head = headed ? line(rows[0]) : line([]);
          const rest = (headed ? rows.slice(1) : rows).map(line);
          body = [head, "|" + " --- |".repeat(width), ...rest].join("\n");
        }
        return "\n\n" + (bg.length ? imagesFor(bg) + "\n\n" : "") + body + "\n\n";
      },
    });

    td.addRule("background", {
      filter: (node) => BACKGROUND_TAGS.has(node.nodeName) && backgroundUrls(node).length > 0,
      replacement(content, node) {
        const images = imagesFor(backgroundUrls(node));
        if (node.nodeName === "SPAN") return images + content;
        if (node.nodeName === "BLOCKQUOTE") {
          const quoted = content.trim().replace(/^/gm, "> ");
          return "\n\n" + images + "\n\n" + quoted + "\n\n";
        }
        return "\n\n" + images + "\n\n" + content + "\n\n";
      },
    });

    function tidy(s) {
      return s
        .replace(/[ \t ]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    function convert(html) {
      return tidy(td.turndown(String(html || "")));
    }

    return function htmlToMarkdown(text) {
      const src = String(text || "").replace(/\r\n?/g, "\n");
      if (!src.trim()) return "";
      return convert(md.render(src));
    };
  }

  if (typeof module === "object" && module.exports) module.exports = create;
  else if (globalThis.JCX && globalThis.TurndownService && globalThis.markdownit) {
    globalThis.JCX.htmlToMarkdown = create(globalThis.TurndownService, globalThis.markdownit);
  }
})();
