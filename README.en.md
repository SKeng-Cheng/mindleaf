# Mindleaf

[简体中文](README.md) · **English**

> Still adding nodes to your mind map one at a time?
> Still asking an AI for a mermaid block, pasting it back, fixing the indentation, and starting over
> because the Chinese came out misaligned?
> We have AI now. Come on.

Papers, projects, breaking a task down — whenever something gets complicated my head turns into a mess.
So I sketch a tree first and fill in the details afterwards. Then I went looking for a mind map tool an
AI could actually work with, and there wasn't one: either I hand-added nodes until I forgot what node ten
said, or the AI generated a wall of code and every change meant starting over.

So I wrote this with DSH. The idea fits in one line:

> **A map is a JSON file. You drag nodes in the browser, the AI edits them through MCP tools, and both
> are working on the same copy.**

Move a node and the AI knows you touched it next time it reads (who, when, what — all recorded). Let the
AI change a batch and your open browser says "modified externally" instead of overwriting whatever you
were typing. No more copy-pasting new versions back and forth.

![The web UI: map list on the left, canvas in the middle, node properties on the right](https://raw.githubusercontent.com/SKeng-Cheng/mindleaf/main/docs/images/ui-light.png)

# Running it

**Node.js 20 or newer**, no dependencies.

```bash
# full repo (read or change the code)
git clone https://github.com/SKeng-Cheng/mindleaf.git
cd mindleaf && node bin/mindleaf.mjs serve --open

# or the minimal package (just to use it — a few hundred KB)
git clone -b lite --depth 1 https://github.com/SKeng-Cheng/mindleaf.git
cd mindleaf && node bin/mindleaf.mjs serve --open
```

On startup it prints two URLs (there's also a **Share** button next to the map name in the top bar):
**open locally** and **send to someone** — a colleague on the same LAN
just opens the second one in a browser, no install, editing the same files as you.

On macOS you can also double-click `启动 Mindleaf.command`. The server exits by itself once every page
is closed.

# What it does

| | |
| --- | --- |
| **Browser editing** | inline edit, drag to reparent, `Tab` / `Enter` to add nodes, undo/redo, collapse, three layouts |
| **Edit with an AI** | MCP over stdio, 21 tools; works with DSH, Codex, Claude Code, Claude Desktop |
| **Annotations** | write "change this bit like so" on a node; the agent sees it first and follows it, and the blue dot goes away when it's done |
| **Hover for notes** | rest the mouse on a node and its note pops up next to the cursor (delay configurable) |
| **Paste images** | ⌘V a screenshot straight into a note, on a node or on the whole map; each stays a small icon until you expand it |
| **Map-level notes** | with nothing selected you edit notes, annotations and images for the whole map |
| **Tags + outline** | tag maps and filter by tag; switch the sidebar to an indented outline, click to jump, collapse in place |
| **Styling** | box / text / line colours, font size, font, box width and height — apply to one node or a whole branch |
| **Relations** | dashed links across branches; click one to edit its label, colour, note or annotation |
| **Links** | attach workspace files, URLs or code line numbers, previewed right in the page |
| **Templates + export** | ten built-in templates; export PNG / JPG / PDF / SVG / Markdown / JSON / HTML |

![Outline sidebar: an indented tree; click a row to jump to that node](https://raw.githubusercontent.com/SKeng-Cheng/mindleaf/main/docs/images/outline.png)

# Docs

- **[MANUAL.md](MANUAL.md)** — the full manual (in Chinese): every feature, all commands, AI setup,
  file format, FAQ
- [AGENTS.md](AGENTS.md) — written for AI agents (Codex reads it automatically)
- [CHANGELOG.md](CHANGELOG.md) — version history

```bash
node bin/mindleaf.mjs help      # command overview
```

# License

[MIT](LICENSE) © 2026 SKeng-Cheng

---

Rough around the edges, but I use it every day. If you end up drawing these trees all the time too, I
hope it saves you some time.
