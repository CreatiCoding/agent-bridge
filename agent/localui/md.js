// Made by scripts/local-md.mjs from ui/src/lib/md-parse.ts (sha256 33d0e0f365204f9d6429a6b181d11105bea92f71ff5778ea4434230ac84153e8) — do not edit.
var CbMd = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var stdin_exports = {};
  __export(stdin_exports, {
    diffLine: () => diffLine,
    inlineParts: () => inlineParts,
    isDiff: () => isDiff,
    parse: () => parse
  });
  const URL_RE = /https?:\/\/[\x21-\x5f\x61-\x7e]+/g;
  function linkify(text) {
    const out = [];
    let at = 0;
    for (const m of text.matchAll(URL_RE)) {
      let url = m[0];
      while (/[.,)\]'"]$/.test(url)) url = url.slice(0, -1);
      if (!url) continue;
      const i = m.index ?? 0;
      if (i > at) out.push({ t: "text", text: text.slice(at, i) });
      out.push({ t: "link", text: url, href: url });
      at = i + url.length;
    }
    if (at < text.length) out.push({ t: "text", text: text.slice(at) });
    return out;
  }
  function inlineParts(text) {
    const out = [];
    const re = /(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)|\*\*([^*\n]+?)\*\*|~~([^~\n]+?)~~|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(^|[\s(])[*_]([^*_\n]+?)[*_](?=[\s).,!?:;]|$)/g;
    let at = 0;
    for (const m of text.matchAll(re)) {
      const i = m.index ?? 0;
      const lead = m[7] ?? "";
      if (i + lead.length > at) out.push(...linkify(text.slice(at, i + lead.length)));
      if (m[2] !== void 0) out.push({ t: "code", text: m[2] });
      else if (m[3] !== void 0) out.push({ t: "strong", kids: inlineParts(m[3]) });
      else if (m[4] !== void 0) out.push({ t: "del", kids: inlineParts(m[4]) });
      else if (m[5] !== void 0) out.push({ t: "link", text: m[5], href: m[6] });
      else if (m[8] !== void 0) out.push({ t: "em", kids: inlineParts(m[8]) });
      at = i + m[0].length;
    }
    if (at < text.length) out.push(...linkify(text.slice(at)));
    return out;
  }
  const isDiff = (code, lang) => lang === "diff" || !lang && /^(@@|\+\+\+|---) /m.test(code) && /^[+-]/m.test(code);
  const diffLine = (l) => l.startsWith("+") && !l.startsWith("+++") ? "d-add" : l.startsWith("-") && !l.startsWith("---") ? "d-del" : l.startsWith("@@") ? "d-hunk" : void 0;
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  function parse(md) {
    const lines = md.replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let para = [];
    const flush = () => {
      if (para.length) blocks.push({ t: "p", text: para.join("\n") });
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        flush();
        const mark = fence[2];
        const body = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const close = new RegExp(`^\\s{0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`).exec(lines[j]);
          if (close) break;
          body.push(lines[j].startsWith(fence[1]) ? lines[j].slice(fence[1].length) : lines[j]);
        }
        blocks.push({ t: "code", lang: fence[3], code: body.join("\n"), closed: j < lines.length });
        i = j;
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        flush();
        blocks.push({ t: "h", level: h[1].length, text: h[2] });
        continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        blocks.push({ t: "hr" });
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
        i--;
        blocks.push({ t: "quote", text: body.join("\n") });
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush();
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : void 0);
        const rows = [];
        i += 2;
        while (i < lines.length && /^\s*\|.*\|?\s*$/.test(lines[i]) && lines[i].trim()) rows.push(cells(lines[i++]));
        i--;
        blocks.push({ t: "table", head, rows, align });
        continue;
      }
      const li = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
      if (li) {
        flush();
        const ordered = !!li[3];
        const items = [];
        const start = ordered ? Number(li[3]) : 1;
        for (; i < lines.length; i++) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (m) {
            const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
            items.push({ text: task ? task[2] : m[3], depth: Math.min(4, Math.floor(m[1].replace(/\t/g, "  ").length / 2)), ...task ? { check: task[1] !== " " } : {} });
          } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1].text += `
${lines[i].trim()}`;
          else break;
        }
        i--;
        blocks.push({ t: "list", ordered, start, items });
        continue;
      }
      para.push(line);
    }
    flush();
    return blocks;
  }
  return __toCommonJS(stdin_exports);
})();
