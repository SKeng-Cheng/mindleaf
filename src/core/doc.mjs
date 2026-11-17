/**
 * 文档模型：Mindleaf 的单一事实来源是一个 JSON 对象（磁盘上是 *.mindmap.json）。
 *
 * 设计约束（给 AI / 给未来的自己）：
 * - 节点用扁平数组 + parent 引用，方便局部增删改，也方便 diff。
 * - 每个节点有稳定 id，任何 agent 都可以用 id 精确改一处，而不必重写整棵树。
 * - rev 单调递增，journal 记录"谁在什么时候改了什么"，让下一个 agent 能读懂人类刚动过哪里。
 * - 本文件是纯 ESM，不依赖 Node API，浏览器与 Node 共用。
 */

export const SCHEMA_VERSION = 1;

/**
 * 可选字体。全部是系统自带字体，栈里按平台依次回退，不加载外部字体。
 * 键名存进文件，渲染时换成 font-family。
 */
export const FONTS = {
  system: {
    label: '系统默认',
    stack:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  },
  hei: { label: '黑体', stack: '"Heiti SC", "SimHei", "Source Han Sans SC", "Microsoft YaHei", sans-serif' },
  song: { label: '宋体', stack: '"Songti SC", "SimSun", "Source Han Serif SC", "Noto Serif CJK SC", Georgia, serif' },
  kai: { label: '楷体', stack: '"Kaiti SC", "KaiTi", "STKaiti", "Kaiti TC", serif' },
  mono: { label: '等宽', stack: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace' },
  serif: { label: '西文衬线', stack: 'Georgia, "Times New Roman", "Songti SC", serif' },
};

export const FONT_KEYS = Object.keys(FONTS);
export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 48;
export const BOX_WIDTH_MIN = 44;
export const BOX_WIDTH_MAX = 600;
export const BOX_HEIGHT_MIN = 24;
export const BOX_HEIGHT_MAX = 500;
export const LAYOUTS = ['right', 'left', 'both'];
export const LINK_KINDS = ['file', 'url', 'code'];

const MAX_JOURNAL = 200;
const MAX_TAGS = 24;
const MAX_TAG_LEN = 24;
const nowISO = () => new Date().toISOString();

export class DocError extends Error {
  constructor(message, code = 'invalid_doc') {
    super(message);
    this.name = 'DocError';
    this.code = code;
  }
}

const clampString = (value, fallback = '') =>
  typeof value === 'string' ? value : value == null ? fallback : String(value);

const isoOr = (value) => {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  return nowISO();
};

export function newDocId() {
  return 'mm_' + Math.random().toString(36).slice(2, 10);
}

/** 生成一个当前文档内不重复的节点 id。 */
export function newNodeId(doc, prefix = 'n') {
  const used = new Set((doc?.nodes ?? []).map((n) => n.id));
  let id;
  do {
    id = `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
  } while (used.has(id));
  return id;
}

/** 根据链接目标猜链接类型（file / url / code）。 */
export function guessLinkKind(target) {
  const value = clampString(target).trim();
  if (/^(https?|mailto):/i.test(value)) return 'url';
  if (/^[a-z]+:\/\//i.test(value)) return 'url';
  if (/(^|[/\\])[^/\\]+\.(mjs|js|ts|tsx|jsx|py|java|c|cc|cpp|h|hpp|go|rs|rb|php|sh|sql|json|ya?ml|toml|css|html?)(#L\d+(-\d+)?)?$/i.test(value)) {
    return 'code';
  }
  if (/#L\d+/.test(value) || /:\d+(:\d+)?$/.test(value)) return 'code';
  return 'file';
}

function normalizeLinks(raw) {
  if (!Array.isArray(raw)) return [];
  const links = [];
  for (const item of raw) {
    if (!item) continue;
    const target = clampString(typeof item === 'string' ? item : item.target).trim();
    if (!target) continue;
    const kind = LINK_KINDS.includes(item?.kind) ? item.kind : guessLinkKind(target);
    const label = clampString(item?.label).trim();
    links.push(label ? { kind, label, target } : { kind, target });
  }
  return links;
}

/**
 * 标签归一化：去掉首尾空白和开头的 #，去重（忽略大小写），限制个数与长度。
 * 空数组表示没有标签。
 */
export function normalizeTags(raw) {
  if (!Array.isArray(raw)) {
    if (typeof raw === 'string') raw = raw.split(/[,，;；]/);
    else return [];
  }
  const seen = new Set();
  const tags = [];
  for (const item of raw) {
    let tag = clampString(item).trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LEN) tag = tag.slice(0, MAX_TAG_LEN).trim();
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/** 标签字符串（"a, b"）或数组都可以。 */
export const tagsToText = (tags) => normalizeTags(tags).join(', ');

const clampNumber = (value, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, Math.round(number)));
};

/** #rgb / #rrggbb / #rrggbbaa 都接受；不合法返回空字符串。 */
export function normalizeHexColor(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!/^#[0-9a-f]{3,8}$/i.test(text)) return '';
  return text.toLowerCase();
}

function normalizeNode(raw, index) {
  const node = {
    id: '',
    parent: raw.parent == null ? null : clampString(raw.parent),
    text: clampString(raw.text),
    note: clampString(raw.note),
    order: Number.isFinite(raw.order) ? raw.order : index,
    collapsed: raw.collapsed === true,
    links: normalizeLinks(raw.links),
  };
  if (typeof raw.id === 'string' && raw.id.trim()) node.id = raw.id.trim();
  // 三个颜色：模块底色 / 字体色 / 连线色，都可以不设
  const color = normalizeHexColor(raw.color);
  const textColor = normalizeHexColor(raw.textColor);
  const lineColor = normalizeHexColor(raw.lineColor);
  if (color) node.color = color;
  if (textColor) node.textColor = textColor;
  if (lineColor) node.lineColor = lineColor;

  const fontSize = clampNumber(raw.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX);
  if (fontSize) node.fontSize = fontSize;
  if (typeof raw.font === 'string' && FONT_KEYS.includes(raw.font.trim())) node.font = raw.font.trim();

  const boxWidth = clampNumber(raw.boxWidth, BOX_WIDTH_MIN, BOX_WIDTH_MAX);
  if (boxWidth) node.boxWidth = boxWidth;
  const boxHeight = clampNumber(raw.boxHeight, BOX_HEIGHT_MIN, BOX_HEIGHT_MAX);
  if (boxHeight) node.boxHeight = boxHeight;
  return node;
}

function normalizeJournal(raw) {
  if (!Array.isArray(raw)) return [];
  const entries = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    entries.push({
      rev: Number.isFinite(item.rev) ? Math.max(0, Math.trunc(item.rev)) : 0,
      at: isoOr(item.at),
      by: clampString(item.by, 'unknown') || 'unknown',
      action: clampString(item.action, 'update') || 'update',
      summary: clampString(item.summary),
    });
  }
  entries.sort((a, b) => a.rev - b.rev);
  return entries.slice(-MAX_JOURNAL);
}

/**
 * 把任意输入整理成合法文档：补默认值、修孤儿节点/环、去重 id、排序子节点。
 * 宁可自动修复也不轻易抛错，因为 agent 手上的数据经常是半成品。
 */
export function normalizeDoc(input) {
  if (!input || typeof input !== 'object') throw new DocError('不是有效的导图对象');
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  const doc = {
    format: 'mindmap',
    schemaVersion: SCHEMA_VERSION,
    id: clampString(input.id) || newDocId(),
    title: clampString(input.title).trim() || '未命名导图',
    createdAt: isoOr(input.createdAt),
    updatedAt: isoOr(input.updatedAt),
    rev: Number.isInteger(input.rev) && input.rev >= 0 ? input.rev : 0,
    settings: {
      layout: LAYOUTS.includes(input.settings?.layout) ? input.settings.layout : 'right',
      theme: input.settings?.theme === 'dark' ? 'dark' : 'light',
    },
    tags: normalizeTags(input.tags),
    nodes: [],
    edges: [],
    journal: normalizeJournal(input.journal),
  };

  const source = rawNodes.length ? rawNodes : [{ id: 'root', parent: null, text: doc.title }];
  const used = new Set();
  for (let i = 0; i < source.length; i += 1) {
    const raw = source[i];
    if (!raw || typeof raw !== 'object') continue;
    const node = normalizeNode(raw, i);
    if (!node.id || used.has(node.id)) node.id = newNodeId(doc, 'n');
    while (used.has(node.id)) node.id = newNodeId(doc, 'n');
    used.add(node.id);
    doc.nodes.push(node);
  }
  if (!doc.nodes.length) {
    doc.nodes.push({ id: 'root', parent: null, text: doc.title, note: '', order: 0, collapsed: false, links: [] });
  }

  // ---- 根节点：只允许一个 ----
  let roots = doc.nodes.filter((n) => n.parent == null);
  if (!roots.length) {
    const fallback = doc.nodes[0];
    fallback.parent = null;
    roots = [fallback];
  }
  const root = roots.find((n) => n.id === 'root') ?? roots[0];
  for (const other of roots) if (other !== root) other.parent = root.id;

  // ---- 父引用修正 + 环/孤儿修复 ----
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  for (const node of doc.nodes) {
    if (node === root) {
      node.parent = null;
      continue;
    }
    if (node.id === root.id) node.parent = null;
    if (node.parent == null || !byId.has(node.parent) || node.parent === node.id) node.parent = root.id;
  }
  for (let guard = 0; guard < 8; guard += 1) {
    const children = new Map();
    for (const node of doc.nodes) {
      if (node.parent == null) continue;
      if (!children.has(node.parent)) children.set(node.parent, []);
      children.get(node.parent).push(node.id);
    }
    const seen = new Set();
    const stack = [root.id];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const childId of children.get(id) ?? []) stack.push(childId);
    }
    const orphans = doc.nodes.filter((n) => n !== root && !seen.has(n.id));
    if (!orphans.length) break;
    for (const orphan of orphans) orphan.parent = root.id;
  }

  // ---- 子节点排序 ----
  const groups = new Map();
  for (const node of doc.nodes) {
    if (node.parent == null) continue;
    if (!groups.has(node.parent)) groups.set(node.parent, []);
    groups.get(node.parent).push(node);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.order - b.order);
    list.forEach((node, index) => {
      node.order = index;
    });
  }

  // ---- 关联线（跨分支连线） ----
  const edgeIds = new Set();
  for (const raw of Array.isArray(input.edges) ? input.edges : []) {
    if (!raw || typeof raw !== 'object') continue;
    const from = clampString(raw.from);
    const to = clampString(raw.to);
    if (!byId.has(from) || !byId.has(to) || from === to) continue;
    let id = clampString(raw.id).trim();
    if (!id || edgeIds.has(id)) {
      do {
        id = `e_${Math.random().toString(36).slice(2, 7)}`;
      } while (edgeIds.has(id));
    }
    edgeIds.add(id);
    const label = clampString(raw.label).trim();
    doc.edges.push(label ? { id, from, to, label } : { id, from, to });
  }

  const journalMax = doc.journal.reduce((max, entry) => Math.max(max, entry.rev), 0);
  doc.rev = Math.max(doc.rev, journalMax);
  doc.updatedAt = isoOr(doc.updatedAt);
  return doc;
}

/** 新建文档。 */
export function createDoc(options = {}) {
  const title = clampString(options.title).trim() || '未命名导图';
  const rootText = clampString(options.rootText, title).trim() || title;
  const at = nowISO();
  return normalizeDoc({
    format: 'mindmap',
    schemaVersion: SCHEMA_VERSION,
    id: newDocId(),
    title,
    createdAt: at,
    updatedAt: at,
    rev: 0,
    settings: {
      layout: LAYOUTS.includes(options.layout) ? options.layout : 'right',
      theme: options.theme === 'dark' ? 'dark' : 'light',
    },
    tags: normalizeTags(options.tags),
    nodes: [{ id: 'root', parent: null, text: rootText, note: '', order: 0, collapsed: false, links: [] }],
    edges: [],
    journal: [{ rev: 0, at, by: options.by ?? 'system', action: 'create', summary: '新建导图' }],
  });
}

/** 记录一次写入：rev 自增、更新 updatedAt、追加 journal。 */
export function recordChange(doc, { by = 'agent', action = 'update', summary = '' } = {}) {
  const rev = doc.rev + 1;
  const at = nowISO();
  doc.rev = rev;
  doc.updatedAt = at;
  doc.journal = [
    ...(doc.journal ?? []),
    { rev, at, by: clampString(by, 'agent') || 'agent', action: clampString(action, 'update') || 'update', summary: clampString(summary) },
  ].slice(-MAX_JOURNAL);
  return doc.journal[doc.journal.length - 1];
}

export function cloneDoc(doc) {
  return structuredClone(doc);
}

export function getNode(doc, id) {
  return doc.nodes.find((node) => node.id === id) ?? null;
}

/** parentId -> 已排序的子节点数组 */
export function childrenMap(doc) {
  const map = new Map();
  for (const node of doc.nodes) {
    if (node.parent == null) continue;
    if (!map.has(node.parent)) map.set(node.parent, []);
    map.get(node.parent).push(node);
  }
  for (const list of map.values()) list.sort((a, b) => a.order - b.order);
  return map;
}

export function childrenOf(doc, id) {
  return childrenMap(doc).get(id) ?? [];
}

export function rootOf(doc) {
  return doc.nodes.find((node) => node.parent == null) ?? doc.nodes[0];
}

/** 先序遍历；visit(node, depth, parent)。返回扁平数组。 */
export function eachNode(doc, visit) {
  const children = childrenMap(doc);
  const out = [];
  const walk = (node, depth, parent) => {
    out.push({ node, depth, parent });
    if (typeof visit === 'function') visit(node, depth, parent);
    for (const child of children.get(node.id) ?? []) walk(child, depth + 1, node);
  };
  walk(rootOf(doc), 0, null);
  return out;
}

export function subtreeIds(doc, id) {
  const children = childrenMap(doc);
  const ids = [];
  const walk = (nodeId) => {
    ids.push(nodeId);
    for (const child of children.get(nodeId) ?? []) walk(child.id);
  };
  walk(id);
  return ids;
}

export function isDescendant(doc, ancestorId, nodeId) {
  let cursor = getNode(doc, nodeId);
  const guard = new Set();
  while (cursor && cursor.parent != null && !guard.has(cursor.id)) {
    if (cursor.parent === ancestorId) return true;
    guard.add(cursor.id);
    cursor = getNode(doc, cursor.parent);
  }
  return false;
}

export function depthOf(doc, id) {
  let depth = 0;
  let cursor = getNode(doc, id);
  const guard = new Set();
  while (cursor && cursor.parent != null && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    cursor = getNode(doc, cursor.parent);
    depth += 1;
  }
  return depth;
}

export function docStats(doc) {
  let maxDepth = 0;
  for (const { depth } of eachNode(doc)) maxDepth = Math.max(maxDepth, depth);
  const collapsed = doc.nodes.filter((n) => n.collapsed).length;
  return { nodes: doc.nodes.length, edges: doc.edges.length, maxDepth, collapsed };
}

/** 给 AI 看的紧凑大纲。 */
export function outline(doc, options = {}) {
  const withLinks = options.withLinks !== false;
  const withNotes = options.withNotes === true;
  const withIds = options.withIds !== false;
  const lines = [];
  eachNode(doc, (node, depth) => {
    const indent = '  '.repeat(depth);
    const idLabel = withIds ? ` 〔${node.id}〕` : '';
    const collapsedLabel = node.collapsed ? ' (已收起)' : '';
    lines.push(`${indent}${node.text || '(空)'}${idLabel}${collapsedLabel}`);
    if (withNotes && node.note) {
      for (const line of node.note.split('\n')) lines.push(`${indent}  ! ${line}`);
    }
    if (withLinks) {
      for (const link of node.links ?? []) {
        lines.push(`${indent}  → ${link.kind}:${link.target}${link.label ? ` (${link.label})` : ''}`);
      }
    }
  });
  return lines.join('\n');
}

/** 校验但不修复；返回问题列表（空数组 = 没问题）。 */
export function docIssues(doc) {
  const issues = [];
  const ids = new Set();
  for (const node of doc.nodes ?? []) {
    if (ids.has(node.id)) issues.push(`重复节点 id: ${node.id}`);
    ids.add(node.id);
  }
  const roots = (doc.nodes ?? []).filter((n) => n.parent == null);
  if (roots.length !== 1) issues.push(`根节点数量应为 1，实际 ${roots.length}`);
  for (const node of doc.nodes ?? []) {
    if (node.parent != null && !ids.has(node.parent)) issues.push(`节点 ${node.id} 的父节点 ${node.parent} 不存在`);
    if (node.parent === node.id) issues.push(`节点 ${node.id} 的父节点是自己`);
  }
  for (const edge of doc.edges ?? []) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) issues.push(`关联线 ${edge.id} 指向不存在的节点`);
  }
  return issues;
}
