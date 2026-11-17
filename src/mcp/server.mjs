/**
 * MCP 服务器（stdio 传输）。
 *
 * 兼容 DSH / Codex / Claude Code / Claude Desktop：它们都走 JSON-RPC 2.0，
 * 只要按 MCP 规范实现 initialize / tools/list / tools/call 即可。
 *
 * 三条铁律（踩过的坑）：
 *  1. stdout 只能输出 JSON-RPC，任何日志都写 stderr；
 *  2. 一行一条 JSON（stdio 传输是"每行一个消息"）；
 *  3. 不要假设宿主给了正确的 cwd —— 项目目录用 --project / MINDLEAF_PROJECT 显式指定，
 *     最后才退回"向上找 mindleaf.json"，再退回工具自身目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, StoreError, findProjectRoot } from '../server/store.mjs';
import {
  FONTS,
  FONT_KEYS,
  annotationsOf,
  getNode,
  rootOf,
  outline,
  eachNode,
  docStats,
  DocError,
} from '../core/doc.mjs';
import { fromMarkdown, guessTitle, toMarkdown } from '../core/markdown.mjs';
import { OP_NAMES } from '../core/ops.mjs';
import { detectEngines } from '../export/raster.mjs';
import { EXPORT_FORMATS } from '../export/exporters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '../..');
const SERVER_VERSION = readVersion();
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

const log = (...args) => process.stderr.write(`[mindleaf] ${args.join(' ')}\n`);

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 解析项目目录：参数 > 环境变量 > 向上查找 > 工具目录。 */
export function resolveProjectDir(explicit) {
  const candidates = [explicit, process.env.MINDLEAF_PROJECT].filter((value) => typeof value === 'string' && value.trim());
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  const found = findProjectRoot(process.cwd()) ?? findProjectRoot(TOOL_ROOT);
  return found ?? TOOL_ROOT;
}

const INSTRUCTIONS = `Mindleaf 是一份本地思维导图文件（<slug>.mindmap.json）。所有工具都作用在同一批文件上，人类可能在网页里同时编辑。

使用建议：
1. 先 mindleaf_list_maps 看有哪些图；不确定结构时 mindleaf_read_map 拿 outline（每个节点带稳定 id）。
2. 修改用节点的 id 精确指定；改多个点时用 mindleaf_apply_ops 一次提交（原子生效）。
3. 每次写操作都会给文档 rev +1，并写一条 journal。人类在网页里的修改同样会 +1，
   所以用 mindleaf_recent_changes 就能知道"人刚刚改了什么"。
4. 导图可以打标签（update_map 的 tags），list_maps 可以用 tag 过滤，list_tags 看全部标签。
5. **节点上的批注（annotation）是人类写给你的修改要求，必须照着改**：read_map 的 outline 里
   以 "⚑ 批注:" 标出，也可以用 mindleaf_list_annotations 一次列出全部。处理完把该节点的
   annotation 置空（update_node annotation: ""），并在 note 里留一句改了什么。
6. 需要给人类看图时用 mindleaf_open_in_browser 起本地网页，人类会看到同一份文件。

Mindleaf is a file-first mind map for humans and agents. Prefer node ids over text.
Read with mindleaf_read_map, write with mindleaf_add_node / mindleaf_update_node /
mindleaf_apply_ops, and export with mindleaf_export_map (png/jpg/pdf/svg/md/json/html).`;

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

const nodeBrief = (node, doc) => {
  const parent = node.parent ? getNode(doc, node.parent) : null;
  return `${node.id}「${node.text}」${parent ? ` ← ${parent.id}「${parent.text}」` : '（根）'}`;
};

/** 允许 AI 用 id 或文字指定节点，文字支持唯一子串匹配。 */
export function resolveNodeRef(doc, ref) {
  const value = String(ref ?? '').trim();
  if (!value) throw new StoreError('缺少节点引用（id 或文字）', 'invalid_argument');
  const byId = getNode(doc, value);
  if (byId) return byId;
  const exact = doc.nodes.filter((node) => node.text === value);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new StoreError(`文字「${value}」命中多个节点，请改用 id：${exact.map((node) => node.id).join(', ')}`, 'ambiguous');
  }
  const lower = value.toLowerCase();
  const fuzzy = doc.nodes.filter((node) => node.text.toLowerCase().includes(lower));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new StoreError(
      `文字「${value}」命中多个节点：${fuzzy
        .slice(0, 8)
        .map((node) => `${node.id}「${node.text}」`)
        .join(', ')}`,
      'ambiguous',
    );
  }
  throw new StoreError(`找不到节点：${value}`, 'not_found');
}

const toolResult = (text, extra = {}) => ({ content: [{ type: 'text', text }], ...extra });

function summarizeAfterWrite(doc, action) {
  const stats = docStats(doc);
  return `rev ${doc.rev} · ${action} · 现在共 ${stats.nodes} 个节点，最大深度 ${stats.maxDepth}`;
}

export function createTools(store) {
  const tools = [];
  const add = (definition, handler) => tools.push({ definition, handler });

  add(
    {
      name: 'mindleaf_list_maps',
      description:
        'List mind maps in the current project (slug, title, rev, node count, tags). Pass "tag" to filter by a tag. Start here when you do not know which map exists.',
      inputSchema: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Only list maps carrying this tag.' },
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const maps = store.list({ tag: args.tag });
      if (!maps.length) {
        const all = store.list();
        if (!all.length) {
          return toolResult(`项目里还没有导图。\n项目目录: ${store.projectDir}\n导图目录: ${store.mapsDir}\n可以用 mindleaf_create_map 新建一个。`);
        }
        return toolResult(`没有带标签「${args.tag}」的导图。现有标签：${store.tagCounts().map((item) => item.tag).join('、') || '（无）'}`);
      }
      const lines = maps.map((map) => {
        const tags = (map.tags ?? []).length ? `  [${map.tags.join(', ')}]` : '';
        return `- ${map.slug}  「${map.title}」  rev ${map.rev}  ${map.nodes} 节点${tags}`;
      });
      const counts = store.tagCounts();
      const tagLine = counts.length ? `\n标签：${counts.map((item) => `${item.tag}(${item.count})`).join('  ')}` : '';
      return toolResult(`${args.tag ? `标签「${args.tag}」下 ${maps.length} 个导图` : `共 ${maps.length} 个导图`}（${store.mapsDir}）：\n${lines.join('\n')}${tagLine}`);
    },
  );

  add(
    {
      name: 'mindleaf_list_tags',
      description: 'List all tags used across mind maps, with how many maps carry each one.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => {
      const counts = store.tagCounts();
      if (!counts.length) return toolResult('现在还没有任何标签。可以用 mindleaf_update_map 的 tags 字段给导图打标签。');
      return toolResult(
        `共 ${counts.length} 个标签：\n${counts.map((item) => `- ${item.tag}  (${item.count} 张图)`).join('\n')}\n\n用 mindleaf_list_maps 的 tag 参数可以只看某个标签下的图。`,
      );
    },
  );

  add(
    {
      name: 'mindleaf_list_annotations',
      description:
        'List every node the human has annotated — these are instructions you are expected to carry out. Omit map to scan all maps. Clear each annotation with mindleaf_update_node annotation:"" when done.',
      inputSchema: {
        type: 'object',
        properties: {
          map: { type: 'string', description: 'Only look at this map. Omit to scan every map.' },
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const targets = args.map ? [store.read(args.map)] : store.list().map((item) => store.read(item.slug));
      if (!targets.length) return toolResult('还没有导图。');
      const blocks = [];
      for (const target of targets) {
        const items = annotationsOf(target.doc);
        if (!items.length) continue;
        blocks.push(
          `## ${target.doc.title}  (slug: ${target.slug})\n` +
            items
              .map((item) => `- 〔${item.id}〕「${item.text}」\n  ⚑ ${item.annotation.replace(/\n/g, '\n    ')}`)
              .join('\n'),
        );
      }
      if (!blocks.length) {
        return toolResult(args.map ? '这张图上没有待处理的批注。' : '所有导图都没有待处理的批注。');
      }
      return toolResult(
        `共 ${blocks.length} 张图有待处理批注：\n\n${blocks.join('\n\n')}\n\n按批注改完之后，用 mindleaf_update_node 把对应节点的 annotation 置空，并在 note 里写一句改了什么。`,
      );
    },
  );

  add(
    {
      name: 'mindleaf_list_templates',
      description: 'List built-in mind map templates (id, title, description, size). Pass the id as "template" to mindleaf_create_map.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => {
      const templates = store.templates();
      const lines = templates.map((item) => `- ${item.id}  ${item.emoji} ${item.title}  (${item.nodes} 节点)  ${item.description}`);
      return toolResult(`内置模板 ${templates.length} 个：\n${lines.join('\n')}\n\n用法: mindleaf_create_map {"title":"...","template":"thesis-outline"}`);
    },
  );

  add(
    {
      name: 'mindleaf_create_map',
      description:
        'Create a new mind map file, optionally from a built-in template (see mindleaf_list_templates). Returns its slug, root node id and revision.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Map title, also used as the file slug.' },
          rootText: { type: 'string', description: 'Root node text (defaults to the title).' },
          layout: { type: 'string', enum: ['right', 'left', 'both'], description: 'Initial layout direction.' },
          template: { type: 'string', description: 'Template id, e.g. thesis-outline / research-plan / literature-review / paper-reading / experiment-design / project-roadmap / meeting-notes / weekly-plan / swot / reading-list.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for this map, e.g. ["论文", "第 3 章"].' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const created = store.create({
        title: args.title,
        rootText: args.rootText ?? args.title,
        layout: args.layout,
        template: args.template,
        tags: args.tags,
        by: 'agent',
      });
      const root = rootOf(created.doc);
      const stats = docStats(created.doc);
      return toolResult(
        `已创建导图「${created.doc.title}」${created.template ? `（模板 ${created.template.title}）` : ''}\nslug: ${created.slug}\n文件: ${created.file}\n根节点 id: ${root.id}\nrev: ${created.doc.rev} · ${stats.nodes} 节点\n\n${outline(created.doc)}`,
      );
    },
  );

  add(
    {
      name: 'mindleaf_read_map',
      description:
        'Read a mind map. Default format "outline" is a compact indented tree with stable node ids (best for planning edits). Use "json" for the full document and "markdown" for a portable outline.',
      inputSchema: {
        type: 'object',
        properties: {
          map: { type: 'string', description: 'Map slug, file name or title.' },
          format: { type: 'string', enum: ['outline', 'json', 'markdown'], default: 'outline' },
          withNotes: { type: 'boolean', description: 'Include node notes in the outline.', default: false },
          withLinks: { type: 'boolean', description: 'Include links in the outline.', default: true },
          withAnnotations: { type: 'boolean', description: 'Include node annotations (human requests for the agent). On by default.', default: true },
        },
        required: ['map'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const { doc, slug, file } = store.read(args.map);
      const format = args.format ?? 'outline';
      const stats = docStats(doc);
      const tagText = (doc.tags ?? []).length ? `，标签 ${doc.tags.join('、')}` : '';
      const header = `# ${doc.title}  (slug: ${slug}, rev ${doc.rev}, ${stats.nodes} 节点, 深 ${stats.maxDepth}${tagText})\n文件: ${file}\n`;
      if (format === 'json') return toolResult(header + JSON.stringify(doc, null, 2));
      if (format === 'markdown') return toolResult(header + '\n' + toMarkdown(doc));
      const hints = annotationsOf(doc);
      const hintLine = hints.length
        ? `\n⚠️ 有 ${hints.length} 条批注等你处理（节点 ${hints.map((item) => item.id).join(', ')}），先看 ⚑ 标记再动手。\n`
        : '';
      return toolResult(
        header +
          hintLine +
          '\n' +
          outline(doc, {
            withNotes: args.withNotes === true,
            withLinks: args.withLinks !== false,
            withAnnotations: args.withAnnotations !== false,
          }),
      );
    },
  );

  add(
    {
      name: 'mindleaf_add_node',
      description:
        'Add one child node under an existing node (parent may be a node id or its exact text). Returns the new node id. Use mindleaf_apply_ops to add many nodes at once.',
      inputSchema: {
        type: 'object',
        properties: {
          map: { type: 'string' },
          parent: { type: 'string', description: 'Parent node id or text. Omit to attach to the root.' },
          text: { type: 'string', description: 'Node text.' },
          note: { type: 'string', description: 'Optional longer note (markdown-ish plain text).' },
          position: { description: 'start | end | index', oneOf: [{ type: 'string' }, { type: 'number' }] },
          links: {
            type: 'array',
            description: 'Links attached to the node, e.g. {"kind":"file","target":"docs/architecture.md"}.',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['file', 'url', 'code'] },
                target: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['target'],
            },
          },
        },
        required: ['map', 'text'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const { doc } = store.read(args.map);
      const parentRef = args.parent != null ? resolveNodeRef(doc, args.parent) : rootOf(doc);
      const { doc: next, results } = store.applyOps(args.map, [
        { op: 'addNode', parent: parentRef.id, text: args.text, note: args.note, links: args.links, position: args.position },
      ], { by: 'agent' });
      const node = results[0];
      return toolResult(`已新增节点 ${nodeBrief(getNode(next, node.id), next)}\n${summarizeAfterWrite(next, '新增节点')}\n\n最新大纲：\n${outline(next)}`);
    },
  );

  add(
    {
      name: 'mindleaf_update_node',
      description:
        'Update one node: text, note, collapsed state, colors (box color / textColor / lineColor), typography (fontSize, font key from list_fonts) or box size (boxWidth / boxHeight, single node only) — or its link list. Only provided fields change. Set subtree=true with colors/fontSize/font to restyle the whole branch at once.',
      inputSchema: {
        type: 'object',
        properties: {
          map: { type: 'string' },
          id: { type: 'string', description: 'Node id (or exact text).' },
          text: { type: 'string' },
          note: { type: 'string' },
          collapsed: { type: 'boolean' },
          color: { type: 'string', description: 'Box fill color, #rrggbb, or "" to clear.' },
          textColor: { type: 'string', description: 'Font color, #rrggbb, or "" to restore the automatic one.' },
          lineColor: { type: 'string', description: 'Color of the line coming into this node; descendants inherit it unless they set their own.' },
          fontSize: { description: 'Font size in px (9-48), or "" for the automatic size.', oneOf: [{ type: 'number' }, { type: 'string' }] },
          font: { type: 'string', description: 'Font key: system / hei / song / kai / mono / serif. "" restores the default.' },
          boxWidth: { description: 'Fixed box width in px (44-600), or "" to auto-fit the text.', oneOf: [{ type: 'number' }, { type: 'string' }] },
          boxHeight: { description: 'Minimum box height in px (24-500), or "" to auto-fit the text.', oneOf: [{ type: 'number' }, { type: 'string' }] },
          annotation: {
            type: 'string',
            description:
              'Instruction the human left for the agent on this node. Pass "" to clear it once handled. Single node only.',
          },
          subtree: {
            type: 'boolean',
            description: 'Apply colors / fontSize / font to this node and every descendant. Box size fields are not allowed in this mode.',
          },
          links: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['file', 'url', 'code'] },
                target: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['target'],
            },
          },
        },
        required: ['map', 'id'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const { doc } = store.read(args.map);
      const node = resolveNodeRef(doc, args.id);
      const patch = { op: 'updateNode', id: node.id };
      for (const key of ['text', 'note', 'collapsed', 'color', 'textColor', 'lineColor', 'fontSize', 'font', 'boxWidth', 'boxHeight', 'annotation', 'links']) {
        if (args[key] !== undefined) patch[key] = args[key];
      }
      if (args.subtree === true) patch.subtree = true;
      const { doc: next } = store.applyOps(args.map, [patch], { by: 'agent' });
      const scope = args.subtree === true ? '（含子节点）' : '';
      return toolResult(`已更新 ${nodeBrief(getNode(next, node.id), next)}${scope}\n${summarizeAfterWrite(next, '更新节点')}`);
    },
  );

  add(
    {
      name: 'mindleaf_remove_node',
      description: 'Delete a node and its whole subtree (cannot delete the root). Related edges are removed too.',
      inputSchema: {
        type: 'object',
        properties: {
          map: { type: 'string' },
          id: { type: 'string', description: 'Node id (or exact text).' },
          reparentChildren: { type: 'boolean', description: 'Keep children by moving them to parent instead of deleting.' },
          parent: { type: 'string', description: 'Target parent when reparentChildren is true.' },
        },
        required: ['map', 'id'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const { doc } = store.read(args.map);
      const node = resolveNodeRef(doc, args.id);
      const parentRef = args.parent != null ? resolveNodeRef(doc, args.parent) : node.parent ? getNode(doc, node.parent) : null;
      const { doc: next, results } = store.applyOps(
        args.map,
        [{ op: 'removeNode', id: node.id, reparentChildren: args.reparentChildren === true, parent: parentRef?.id }],
        { by: 'agent' },
      );
      const removed = results[0]?.removed ?? [node.id];
      return toolResult(`已删除 ${removed.length} 个节点（含「${node.text}」）。\n${summarizeAfterWrite(next, '删除节点')}`);
    },
  );

  add(
    {
      name: 'mindleaf_move_node',
      description: 'Move a node (with its subtree) under a new parent, optionally to a specific position among siblings.',
      inputSchema: {
        type: 'object',
        properties: {
          map: { type: 'string' },
          id: { type: 'string' },
          parent: { type: 'string', description: 'New parent id or text.' },
          position: { description: 'start | end | index', oneOf: [{ type: 'string' }, { type: 'number' }] },
        },
        required: ['map', 'id', 'parent'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const { doc } = store.read(args.map);
      const node = resolveNodeRef(doc, args.id);
      const parent = resolveNodeRef(doc, args.parent);
      const { doc: next } = store.applyOps(args.map, [{ op: 'moveNode', id: node.id, parent: parent.id, position: args.position }], { by: 'agent' });
      return toolResult(`已移动「${node.text}」到「${parent.text}」下面。\n${summarizeAfterWrite(next, '移动节点')}`);
    },
  );

  add(
    {
      name: 'mindleaf_apply_ops',
      description: `Apply several operations atomically (all or nothing). Ops: ${OP_NAMES.join(', ')}.
Example: {"ops":[{"op":"addNode","parent":"n_root","text":"第 1 章"},{"op":"addNode","parent":"n_root","text":"第 2 章"},{"op":"addEdge","from":"n_a","to":"n_b","label":"验证"}]}`,
      inputSchema: {
        type: 'object',
        properties: {
          map: { type: 'string' },
          ops: { type: 'array', description: 'Operation objects, each with an "op" field.', items: { type: 'object' } },
          summary: { type: 'string', description: 'Optional human-readable summary recorded in the journal.' },
        },
        required: ['map', 'ops'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const { doc: before } = store.read(args.map);
      // 允许 op 里用文字引用节点：先把 parent/from/to/id 里的文字换成 id
      const normalized = (args.ops ?? []).map((raw) => {
        const op = { ...raw };
        for (const key of ['id', 'parent', 'from', 'to']) {
          if (typeof op[key] === 'string') {
            try {
              op[key] = resolveNodeRef(before, op[key]).id;
            } catch {
              /* 保持原样，让 core 报错 */
            }
          }
        }
        return op;
      });
      const { doc: next, results } = store.applyOps(args.map, normalized, { by: 'agent', summary: args.summary });
      const summary = normalized.map((op) => op.op ?? op.type).join(', ');
      return toolResult(`${results.length} 个操作已应用（${summary}）。\n${summarizeAfterWrite(next, '批量更新')}\n\n最新大纲：\n${outline(next)}`);
    },
  );

  add(
    {
      name: 'mindleaf_add_edge',
      description: 'Draw a cross-branch relation (dashed arrow) between two nodes, with an optional label.',
      inputSchema: {
        type: 'object',
        properties: {
          map: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['map', 'from', 'to'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const { doc } = store.read(args.map);
      const from = resolveNodeRef(doc, args.from);
      const to = resolveNodeRef(doc, args.to);
      const { doc: next, results } = store.applyOps(args.map, [{ op: 'addEdge', from: from.id, to: to.id, label: args.label }], { by: 'agent' });
      return toolResult(`已添加关联线 ${results[0]?.id}：${from.text} → ${to.text}${args.label ? `（${args.label}）` : ''}\n${summarizeAfterWrite(next, '关联线')}`);
    },
  );

  add(
    {
      name: 'mindleaf_update_map',
      description:
        'Change map-level settings: title, layout (right/left/both), theme (light/dark) or tags (an array; empty array clears them).',
      inputSchema: {
        type: 'object',
        properties: {
          map: { type: 'string' },
          title: { type: 'string' },
          layout: { type: 'string', enum: ['right', 'left', 'both'] },
          theme: { type: 'string', enum: ['light', 'dark'] },
          tags: { type: 'array', items: { type: 'string' }, description: 'Replace the tag list; pass [] to clear all tags.' },
        },
        required: ['map'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const patch = { op: 'setDoc', title: args.title, layout: args.layout, theme: args.theme };
      if (Array.isArray(args.tags)) patch.tags = args.tags;
      const { doc: next } = store.applyOps(args.map, [patch], { by: 'agent' });
      const tags = (next.tags ?? []).length ? next.tags.join('、') : '（无）';
      return toolResult(
        `已更新导图设置：「${next.title}」，layout=${next.settings.layout}，theme=${next.settings.theme}，标签=${tags}。\n${summarizeAfterWrite(next, '设置')}`,
      );
    },
  );

  add(
    {
      name: 'mindleaf_list_fonts',
      description: 'List the font keys accepted by mindleaf_update_node (font field) and mindleaf_update_map. All are system fonts, nothing is downloaded.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => {
      const lines = FONT_KEYS.map((key) => `- ${key}  ${FONTS[key].label}`);
      return toolResult(`可用字体（存键名，渲染时换成系统字体栈）：\n${lines.join('\n')}`);
    },
  );

  add(
    {
      name: 'mindleaf_export_map',
      description:
        'Export the map to a file. Formats: png, jpg, pdf, svg, md, json, html. Without "path" it writes into the project exports/ directory and returns the absolute path (good for citing in a paper).',
      inputSchema: {
        type: 'object',
        properties: {
          map: { type: 'string' },
          format: { type: 'string', enum: EXPORT_FORMATS, default: 'png' },
          path: { type: 'string', description: 'Output path (absolute, or relative to the project root).' },
          scale: { type: 'number', description: 'Pixel scale for png/jpg (default 2).' },
          quality: { type: 'number', description: 'jpg/pdf image quality 1-100.' },
        },
        required: ['map'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const format = args.format ?? 'png';
      const { slug, doc } = store.read(args.map);
      const target = args.path
        ? path.isAbsolute(args.path)
          ? args.path
          : path.resolve(store.projectDir, args.path)
        : path.join(store.exportsDir, `${slug}.${format}`);
      const result = await store.exportMap(slug, { format, path: target, scale: args.scale, quality: args.quality, name: slug });
      const warnings = result.warnings?.length ? `\n注意: ${result.warnings.join('；')}` : '';
      return toolResult(
        `已导出「${doc.title}」为 ${format.toUpperCase()}：\n${result.path}\n大小 ${(result.bytes / 1024).toFixed(1)}KB · 渲染后端 ${result.engine} · 画布 ${result.width}x${result.height}${warnings}`,
      );
    },
  );

  add(
    {
      name: 'mindleaf_import_markdown',
      description:
        'Create or replace a map from a Markdown outline. Heading levels become the tree: "# title" is the root, "## " first-level branches, and bullet lines / paragraphs become node notes.',
      inputSchema: {
        type: 'object',
        properties: {
          map: { type: 'string', description: 'Existing map slug/title, or "new" to create one.' },
          markdown: { type: 'string' },
          title: { type: 'string', description: 'Title override when creating.' },
        },
        required: ['map', 'markdown'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const title = args.title ?? guessTitle(args.markdown) ?? '导入的导图';
      const doc = fromMarkdown(args.markdown, { title });
      if (String(args.map) === 'new') {
        const created = store.create({ title: doc.title, by: 'agent' });
        const saved = store.save(created.slug, doc, { by: 'agent', summary: '从 Markdown 导入', force: true });
        return toolResult(`已从 Markdown 新建导图「${saved.doc.title}」（slug: ${saved.slug}，${docStats(saved.doc).nodes} 节点）。`);
      }
      const saved = store.save(args.map, doc, { by: 'agent', summary: '从 Markdown 覆盖导入', force: true });
      return toolResult(`已用 Markdown 覆盖「${saved.doc.title}」（slug: ${saved.slug}，${docStats(saved.doc).nodes} 节点）。`);
    },
  );

  add(
    {
      name: 'mindleaf_recent_changes',
      description:
        'Show what changed recently (including edits made by the human in the web UI). Returns journal entries after sinceRev plus a node-level diff when a snapshot is available.',
      inputSchema: {
        type: 'object',
        properties: {
          map: { type: 'string' },
          sinceRev: { type: 'number', description: 'Only changes with rev > sinceRev. Default 0 (latest entries).' },
        },
        required: ['map'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const { doc, slug } = store.read(args.map);
      const since = Number.isFinite(args.sinceRev) ? args.sinceRev : Math.max(0, doc.rev - 5);
      const changes = store.changesSince(slug, since);
      const lines = changes.journal.map((entry) => `- rev ${entry.rev} · ${entry.at} · ${entry.by} · ${entry.action} · ${entry.summary}`);
      const diffLines = changes.changedNodes.slice(0, 60).map((change) => {
        if (change.type === 'add') return `+ ${change.id}「${change.text}」`;
        if (change.type === 'remove') return `- ${change.id}「${change.text}」`;
        if (change.type === 'move') return `> ${change.id} 从 ${change.from} 移到 ${change.to}`;
        return `~ ${change.id}.${change.field}: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`;
      });
      const baseNote = changes.baseRev != null && changes.baseRev < since ? `（快照只回溯到 rev ${changes.baseRev}，差异以它为基准）` : '';
      return toolResult(
        `导图「${doc.title}」当前 rev ${doc.rev}，rev > ${since} 的记录：\n${lines.join('\n') || '（无）'}\n\n节点级差异${baseNote}${
          diffLines.length ? '：\n' + diffLines.join('\n') : '（没有可用的历史快照）'
        }`,
      );
    },
  );

  add(
    {
      name: 'mindleaf_open_in_browser',
      description:
        'Start (if needed) the local Mindleaf web app and open it in the default browser so the human can view/edit the same files. Returns the URL.',
      inputSchema: {
        type: 'object',
        properties: {
          map: { type: 'string', description: 'Optional map slug to focus.' },
          port: { type: 'number', description: 'Preferred port (default 7788, auto-increments when busy).' },
          open: { type: 'boolean', description: 'Open the default browser (default true).', default: true },
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const session = await ensureServer(store, args.port);
      const url = args.map ? `${session.url}/#${encodeURIComponent(args.map)}` : session.url;
      if (args.open !== false) {
        const { openInBrowser } = await import('../export/raster.mjs');
        await openInBrowser(url);
      }
      return toolResult(`网页已就绪：${url}\n（服务进程随本 MCP 进程存活；进程退出后网页失效，可改用它自己的 \`mindleaf serve\` 常驻。）`);
    },
  );

  add(
    {
      name: 'mindleaf_doctor',
      description: 'Report environment capabilities: project paths, export backends (headless Chromium / sips), and how to fix missing ones.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => {
      const engines = detectEngines();
      return toolResult(
        [
          `项目目录: ${store.projectDir}`,
          `导图目录: ${store.mapsDir}`,
          `工作区(相对链接根): ${store.workspaceDir}`,
          `导出目录: ${store.exportsDir}`,
          `无头浏览器: ${engines.chromium[0] ?? '未找到（PDF 将退化为位图，PNG/JPG 需要 sips 或 rsvg-convert）'}`,
          `sips: ${engines.sips ?? '无'}`,
          `可用格式: ${EXPORT_FORMATS.join(', ')}`,
        ].join('\n'),
      );
    },
  );

  return tools;
}

// ---------------------------------------------------------------------------
// 内嵌网页服务（供 mindleaf_open_in_browser 使用）
// ---------------------------------------------------------------------------
let embeddedSession = null;
async function ensureServer(store, port) {
  if (embeddedSession) return embeddedSession;
  const { startServer } = await import('../server/http.mjs');
  embeddedSession = await startServer({ store, port: Number.isInteger(port) ? port : 7788 });
  return embeddedSession;
}

// ---------------------------------------------------------------------------
// JSON-RPC 循环
// ---------------------------------------------------------------------------
export async function runMcpServer(options = {}) {
  const projectDir = resolveProjectDir(options.project);
  const store = new Store({ projectDir }).init();
  store.watch();
  const tools = createTools(store);
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const transport = options.transport ?? 'stdio';

  log(`MCP server v${SERVER_VERSION} · project=${projectDir} · maps=${store.mapsDir} · transport=${transport}`);

  const send = (message) => {
    process.stdout.write(JSON.stringify(message) + '\n');
  };
  const sendResult = (id, result) => send({ jsonrpc: '2.0', id, result });
  const sendError = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  const handle = async (message) => {
    const { id, method, params } = message ?? {};
    const isNotification = id === undefined || id === null;
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL;
        sendResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false }, logging: {} },
          serverInfo: { name: 'mindleaf', version: SERVER_VERSION, title: 'Mindleaf' },
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case 'notifications/initialized':
      case 'initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
        return;
      case 'ping':
        if (!isNotification) sendResult(id, {});
        return;
      case 'tools/list':
        sendResult(id, { tools: tools.map((tool) => tool.definition) });
        return;
      case 'tools/call': {
        const name = params?.name;
        const tool = byName.get(name);
        if (!tool) {
          sendError(id, -32602, `未知工具: ${name}`);
          return;
        }
        try {
          const result = await tool.handler(params?.arguments ?? {});
          sendResult(id, { content: result.content, isError: result.isError === true });
        } catch (error) {
          const messageText = error instanceof StoreError || error instanceof DocError ? error.message : error?.message ?? String(error);
          log(`tool ${name} failed: ${messageText}`);
          sendResult(id, { content: [{ type: 'text', text: `错误: ${messageText}` }], isError: true });
        }
        return;
      }
      case 'resources/list':
        sendResult(id, { resources: [] });
        return;
      case 'resources/templates/list':
        sendResult(id, { resourceTemplates: [] });
        return;
      case 'prompts/list':
        sendResult(id, { prompts: [] });
        return;
      case 'logging/setLevel':
        if (!isNotification) sendResult(id, {});
        return;
      case 'completion/complete':
        sendResult(id, { completion: { values: [] } });
        return;
      default:
        if (!isNotification) sendError(id, -32601, `不支持的方法: ${method}`);
    }
  };

  const handleLine = async (line) => {
    const text = line.trim();
    if (!text) return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      sendError(null, -32700, `JSON 解析失败: ${error.message}`);
      return;
    }
    if (Array.isArray(parsed)) {
      for (const message of parsed) await handle(message);
      return;
    }
    try {
      await handle(parsed);
    } catch (error) {
      log(`handler error: ${error?.stack ?? error}`);
      if (parsed && parsed.id !== undefined) sendError(parsed.id, -32603, error?.message ?? '内部错误');
    }
  };

  if (transport !== 'stdio') throw new Error(`暂不支持的 MCP 传输: ${transport}`);

  let buffer = '';
  process.stdin.setEncoding('utf8');
  let chain = Promise.resolve();
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      chain = chain.then(() => handleLine(line));
      index = buffer.indexOf('\n');
    }
  });
  process.stdin.on('end', () => {
    if (buffer.trim()) chain = chain.then(() => handleLine(buffer));
    chain.then(() => {
      if (embeddedSession) embeddedSession.close().catch(() => undefined);
      log('stdin closed, exiting');
      process.exit(0);
    });
  });
  // 保持进程存活
  await new Promise(() => undefined);
}

export { SERVER_VERSION, INSTRUCTIONS, eachNode };
