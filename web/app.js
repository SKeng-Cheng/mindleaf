/**
 * mindleaf 网页前端（纯浏览器 ESM，零依赖、无构建）。
 *
 * 分区：
 *   1. 常量 / 小工具        2. 状态
 *   3. API 封装             4. 主题与画布渲染
 *   5. 导图列表 / 顶栏 / 检查器渲染
 *   6. 画布交互（缩放、平移、选中、拖拽、行内编辑）
 *   7. 文档操作（ops、撤销、节点结构）
 *   8. 面板 / 对话框（模板向导、导入、设置、预览抽屉）
 *   9. 导出                 10. 实时同步
 *   11. 启动
 *
 * 约定：服务端是唯一事实来源。所有修改都走 /ops 或 PUT，并用响应里的 doc 校准本地状态。
 */

import {
  layoutDoc,
  renderSvg,
  createDoc,
  applyOps,
  getNode,
  childrenOf,
  guessLinkKind,
  docStats,
} from '/src/core/index.mjs';

/* ==========================================================================
   1. 常量 / 小工具
   ========================================================================== */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clone = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
const isMobile = () => window.matchMedia('(max-width: 900px)').matches;
const truncate = (text, length = 24) => {
  const value = String(text ?? '').replace(/\s+/g, ' ');
  return value.length > length ? `${value.slice(0, length)}…` : value;
};

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 3;
const UNDO_LIMIT = 50;
const LAYOUT_LABELS = { right: '向右', left: '向左', both: '双向' };
const KIND_LABELS = { file: '文件', url: '网址', code: '代码' };

const COLOR_PRESETS = [
  { value: '#fde68a', name: '琥珀' },
  { value: '#bbf7d0', name: '薄荷' },
  { value: '#bfdbfe', name: '天蓝' },
  { value: '#fecdd3', name: '樱粉' },
  { value: '#ddd6fe', name: '薰衣草' },
  { value: '#fed7aa', name: '杏橙' },
];

// 字体色和连线色是深色/饱和色，跟模块底色分开两套预设
const TEXT_COLORS = [
  { value: '#1f2937', name: '墨黑' },
  { value: '#b91c1c', name: '红' },
  { value: '#1d4ed8', name: '蓝' },
  { value: '#047857', name: '绿' },
  { value: '#6d28d9', name: '紫' },
  { value: '#b45309', name: '橙' },
];

const LINE_COLORS = [
  { value: '#64748b', name: '灰' },
  { value: '#0ea5e9', name: '天蓝' },
  { value: '#10b981', name: '绿' },
  { value: '#f59e0b', name: '橙' },
  { value: '#ef4444', name: '红' },
  { value: '#8b5cf6', name: '紫' },
];

const FONT_CHOICES = [
  { key: '', label: '默认' },
  { key: 'system', label: '系统' },
  { key: 'hei', label: '黑体' },
  { key: 'song', label: '宋体' },
  { key: 'kai', label: '楷体' },
  { key: 'mono', label: '等宽' },
  { key: 'serif', label: '西文衬线' },
];

const FONT_SIZE_CHOICES = [0, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32];

const STYLE_FIELDS = [
  { key: 'color', label: '模块', presets: COLOR_PRESETS, hint: '节点底色' },
  { key: 'textColor', label: '文字', presets: TEXT_COLORS, hint: '节点里的字' },
  { key: 'lineColor', label: '连线', presets: LINE_COLORS, hint: '连到该节点的那条线，子节点会跟着继承' },
];

const ICON = {
  slash: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="m6.5 17.5 11-11"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
  cursor: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 4 14 7-6 1.6L9.5 19 5 4Z"/></svg>',
  leaf: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19c0-6.5 5.4-11.8 14.5-12.8C18.5 15.5 13.7 20 7 20"/><path d="M5 20c2.5-4.4 6-7.2 9.5-8.9"/></svg>',
  tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h8l8 8-8 8-8-8z"/><circle cx="8.5" cy="8.5" r="1.4"/></svg>',
};

const formatBytes = (bytes) => {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
};

const formatTime = (iso) => {
  if (!iso) return '—';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '—';
  const diff = Date.now() - time;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 86400 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  const date = new Date(time);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
};

const basename = (value) => {
  const parts = String(value ?? '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? String(value ?? '');
};

const isTextInput = (target) =>
  !!target && (target.matches?.('input, textarea, select') || target.isContentEditable === true);

/** 简单防抖，返回的函数带 cancel()。 */
const debounce = (fn, wait) => {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
};

const rootId = (doc) => doc?.nodes?.find((node) => node.parent == null)?.id ?? doc?.nodes?.[0]?.id ?? null;

/** 节点在树里的深度（根 = 0）。 */
function nodeDepth(doc, id) {
  let depth = 0;
  let cursor = getNode(doc, id);
  const seen = new Set();
  while (cursor && cursor.parent != null && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    depth += 1;
    cursor = getNode(doc, cursor.parent);
  }
  return depth;
}

/** 解析链接目标里的行号范围，如 src/a.mjs#L10-L20、README.md:12。 */
function parseLinkTarget(target) {
  const value = String(target ?? '');
  const hash = /#L(\d+)(?:-L?(\d+))?$/.exec(value);
  if (hash) return { path: value.slice(0, hash.index), range: [Number(hash[1]), Number(hash[2] ?? hash[1])] };
  if (!/^[a-z]+:\/\//i.test(value)) {
    const colon = /:(\d+)(?::(\d+))?$/.exec(value);
    if (colon) return { path: value.slice(0, colon.index), range: [Number(colon[1]), Number(colon[2] ?? colon[1])] };
  }
  return { path: value, range: null };
}

const fileBase = (doc) =>
  String(doc?.title ?? 'mindmap')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'mindmap';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('SVG 转图片失败'));
    image.src = url;
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ==========================================================================
   2. 状态
   ========================================================================== */

const state = {
  boot: null, // /api/state 快照
  maps: [],
  templates: [],
  templatesFailed: false,
  query: '',
  sidebarTab: 'maps', // maps | outline
  styleScope: 'node', // node | subtree
  tagFilter: '',
  outlineQuery: '',
  slug: null,
  doc: null,
  rev: 0,
  selectedId: null,
  layout: null, // 最近一次 layoutDoc 结果
  zoom: 1,
  pan: { x: 0, y: 0 },
  editingId: null,
  undo: [],
  redo: [],
  pendingOps: 0,
  externalSignal: false,
  exporting: false,
  syncOnline: false,
  linkEditIndex: null,
  linkDraft: { kind: 'auto', target: '', label: '' },
  preview: { path: null, abs: null, range: null },
  wizard: { step: 1, templateId: '', titleTouched: false },
  drag: { mode: null, pointerId: null, startX: 0, startY: 0, originX: 0, originY: 0, moved: false, nodeId: null, dropId: null },
};

/* ==========================================================================
   3. API
   ========================================================================== */

class ApiError extends Error {
  constructor(message, code = 'error', payload = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.payload = payload;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('无法连接 mindleaf 服务，请确认终端里的 serve 仍在运行', 'network');
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text.slice(0, 200) };
    }
  }
  if (!response.ok) {
    throw new ApiError(data?.message || data?.error || `请求失败（${response.status}）`, data?.error, data);
  }
  return data;
}

/* ==========================================================================
   4. 主题与画布渲染
   ========================================================================== */

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function systemTheme() {
  return systemDark.matches ? 'dark' : 'light';
}

function currentTheme() {
  const theme = state.doc?.settings?.theme;
  if (theme === 'dark' || theme === 'light') return theme;
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : document.documentElement.dataset.theme === 'light' ? 'light' : systemTheme();
}

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'dark' ? '#0f1726' : '#ffffff');
}

/** 让画布底色、点阵、选中色跟随核心库给出的 palette。 */
function applyCanvasPalette(palette) {
  const area = $('#canvas-area');
  if (!area || !palette) return;
  area.style.setProperty('--canvas', palette.canvas);
  area.style.setProperty('--grid', palette.dark ? 'rgba(148,163,184,.13)' : 'rgba(15,23,42,.055)');
  area.style.setProperty('--select', palette.dark ? '#60a5fa' : '#2563eb');
}

function applyTransform() {
  const stage = $('#canvas-stage');
  stage.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  $('#zoom-value').textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitView() {
  if (!state.layout) return;
  const viewport = $('#canvas-viewport');
  const width = viewport.clientWidth || 800;
  const height = viewport.clientHeight || 600;
  const padding = 48;
  const zoom = clamp(Math.min((width - padding * 2) / state.layout.width, (height - padding * 2) / state.layout.height), ZOOM_MIN, 1.25);
  state.zoom = zoom;
  state.pan.x = (width - state.layout.width * zoom) / 2;
  state.pan.y = (height - state.layout.height * zoom) / 2;
  applyTransform();
}

function renderCanvas({ fit = false } = {}) {
  const stage = $('#canvas-stage');
  const empty = $('#empty-state');
  if (!state.doc) {
    stage.innerHTML = '';
    state.layout = null;
    empty.hidden = false;
    $('#canvas-top').hidden = true;
    return;
  }
  empty.hidden = true;
  $('#canvas-top').hidden = false;
  applyTheme(currentTheme());
  state.layout = layoutDoc(state.doc, { direction: state.doc.settings?.layout ?? 'right', theme: currentTheme() });
  stage.innerHTML = renderSvg(state.layout, { background: false, title: state.doc.title, idPrefix: 'ui' });
  applyCanvasPalette(state.layout.palette);
  applyTransform();
  applySelectionClass();
  if (fit) fitView();
}

function applySelectionClass() {
  for (const group of $$('#canvas-stage g[data-node-id]')) {
    group.classList.toggle('is-selected', group.dataset.nodeId === state.selectedId);
  }
  for (const row of $$('#outline-panel .outline-row')) {
    const active = row.dataset.id === state.selectedId;
    row.classList.toggle('is-selected', active);
    row.setAttribute('aria-selected', active ? 'true' : 'false');
  }
}

function getLayoutNode(id) {
  return state.layout?.nodes?.find((node) => node.id === id) ?? null;
}

/** 把某个节点滚动到可视范围内（键盘导航时用）。 */
function ensureNodeVisible(id) {
  const node = getLayoutNode(id);
  if (!node) return;
  const viewport = $('#canvas-viewport');
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const margin = 52;
  const x = node.x * state.zoom + state.pan.x;
  const y = node.y * state.zoom + state.pan.y;
  const w = node.width * state.zoom;
  const h = node.height * state.zoom;
  if (x < margin) state.pan.x += margin - x;
  else if (x + w > width - margin) state.pan.x -= x + w - (width - margin);
  if (y < margin) state.pan.y += margin - y;
  else if (y + h > height - margin) state.pan.y -= y + h - (height - margin);
  applyTransform();
}

/* ==========================================================================
   5. 侧栏 / 顶栏 / 检查器 / 状态栏 渲染
   ========================================================================== */

function renderTopbar() {
  const title = $('#doc-title');
  title.textContent = state.doc ? state.doc.title : '未选择导图';
  title.classList.toggle('is-empty', !state.doc);
  title.title = state.doc ? '重命名当前导图' : '未选择导图';

  $('#btn-undo').disabled = !state.undo.length;
  $('#btn-redo').disabled = !state.redo.length;
  const exportBtn = $('#btn-export');
  exportBtn.disabled = !state.doc || state.exporting;
  exportBtn.querySelector('span').textContent = state.exporting ? '导出中…' : '导出';

  $('#btn-theme').title = currentTheme() === 'dark' ? '切换到浅色主题' : '切换到深色主题';

  for (const button of $$('#layout-seg .seg-btn')) {
    const active = (state.doc?.settings?.layout ?? 'right') === button.dataset.layout;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  document.title = state.doc ? `${state.doc.title} · mindleaf` : 'mindleaf · 思维导图';
}

/** 把 "a, b；c" 之类的输入拆成标签数组（归一化交给服务端）。 */
function parseTagInput(raw) {
  return String(raw ?? '')
    .split(/[,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const mapMatchesQuery = (map, query) => {
  if (!query) return true;
  const haystack = [map.title, map.slug, ...(map.tags ?? [])].join(' ').toLowerCase();
  return haystack.includes(query);
};

/** 侧栏顶部的标签筛选条。 */
function renderTagFilter() {
  const box = $('#tag-filter');
  if (!box) return;
  const tags = state.boot?.tags ?? [];
  if (!tags.length) {
    box.hidden = true;
    box.innerHTML = '';
    if (state.tagFilter) state.tagFilter = '';
    return;
  }
  if (state.tagFilter && !tags.some((item) => item.tag.toLowerCase() === state.tagFilter.toLowerCase())) {
    state.tagFilter = '';
  }
  const chip = (tag, count, active) =>
    `<button type="button" class="tag-chip${active ? ' is-active' : ''}" data-tag="${esc(tag)}" aria-pressed="${active ? 'true' : 'false'}" title="按标签「${esc(tag)}」筛选">${esc(tag)}<span class="tag-count">${count}</span></button>`;
  box.innerHTML = [
    `<button type="button" class="tag-chip${state.tagFilter ? '' : ' is-active'}" data-tag="" aria-pressed="${state.tagFilter ? 'false' : 'true'}">全部</button>`,
    ...tags.map((item) => chip(item.tag, item.count, item.tag.toLowerCase() === state.tagFilter.toLowerCase())),
  ].join('');
  box.hidden = false;
}

function renderMapList() {
  const list = $('#map-list');
  const query = state.query.trim().toLowerCase();
  const tag = state.tagFilter.toLowerCase();
  const maps = state.maps.filter((map) => {
    if (tag && !(map.tags ?? []).some((item) => item.toLowerCase() === tag)) return false;
    return mapMatchesQuery(map, query);
  });
  list.innerHTML = maps
    .map(
      (map) => `
      <div class="map-item${map.slug === state.slug ? ' is-active' : ''}" role="listitem" tabindex="0" data-slug="${esc(map.slug)}" aria-current="${map.slug === state.slug ? 'true' : 'false'}">
        <div class="map-item-main">
          <div class="map-item-title">${esc(map.title || map.slug)}</div>
          <div class="map-item-meta">
            <span class="rev">r${map.rev ?? 0}</span>
            <span class="map-nodes">${map.nodes ?? 0} 节点</span>
            <span class="dot">·</span>
            <span class="map-time">${formatTime(map.updatedAt)}</span>
          </div>
          ${(map.tags ?? []).length ? `<div class="map-item-tags">${(map.tags ?? [])
            .map((item) => `<button type="button" class="map-item-tag" data-tag="${esc(item)}" title="只看标签「${esc(item)}」">${esc(item)}</button>`)
            .join('')}</div>` : ''}
        </div>
        <button class="map-item-tags-edit" data-tags="${esc(map.slug)}" title="编辑标签" aria-label="编辑「${esc(map.title || map.slug)}」的标签">${ICON.tag}</button>
        <button class="map-item-del" data-del="${esc(map.slug)}" title="删除导图" aria-label="删除导图 ${esc(map.title || map.slug)}">${ICON.trash}</button>
      </div>`,
    )
    .join('');

  const empty = $('#sidebar-empty');
  empty.hidden = maps.length > 0;
  empty.textContent = state.maps.length ? '没有匹配的导图' : '还没有导图，点下面按钮新建一张';
  if (empty.hidden === false && state.tagFilter) empty.textContent = `没有带标签「${state.tagFilter}」的导图`;
}

/**
 * 大纲侧栏：把当前导图按层级摊平成一列，点哪行就跳到哪个节点。
 * 折叠的节点不展开子节点；搜索时自动展开命中的分支并只显示命中路径。
 */
function renderOutline() {
  const panel = $('#outline-panel');
  const empty = $('#outline-empty');
  if (!panel) return;
  if (!state.doc) {
    panel.innerHTML = '';
    panel.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  panel.hidden = false;

  const childrenOf = (id) => (state.doc.nodes ?? []).filter((node) => node.parent === id).sort((a, b) => a.order - b.order);
  const query = state.outlineQuery.trim().toLowerCase();
  const root = state.doc.nodes.find((node) => node.parent == null);
  if (!root) {
    panel.innerHTML = '';
    return;
  }

  // 先把整棵树摊平，记录每个节点是否命中、子树是否有命中
  const rows = [];
  const hit = new Set();
  const hasHit = new Set();
  const walk = (node, depth, ancestors) => {
    const matched = query ? String(node.text ?? '').toLowerCase().includes(query) : false;
    if (matched) {
      hit.add(node.id);
      for (const id of ancestors) hasHit.add(id);
    }
    rows.push({ node, depth, matched });
    const collapsed = node.collapsed === true;
    if (collapsed && !query) return;
    for (const child of childrenOf(node.id)) walk(child, depth + 1, [...ancestors, node.id]);
  };
  walk(root, 0, []);

  const visible = query ? rows.filter((row) => hit.has(row.node.id) || hasHit.has(row.node.id)) : rows;
  const caret = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  panel.innerHTML = visible
    .map(({ node, depth, matched }) => {
      const kids = childrenOf(node.id).length;
      const isSelected = node.id === state.selectedId;
      const classes = [
        'outline-row',
        `outline-depth-${Math.min(depth, 6)}`,
        isSelected ? 'is-selected' : '',
        matched ? 'is-match' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `<div class="${classes}" role="treeitem" tabindex="0" data-id="${esc(node.id)}" aria-level="${depth + 1}" aria-selected="${isSelected ? 'true' : 'false'}" style="--depth:${depth}">
        <button type="button" class="outline-caret${node.collapsed ? ' is-collapsed' : ''}${kids ? '' : ' is-leaf'}" data-caret="${esc(node.id)}" tabindex="-1" title="${node.collapsed ? '展开' : '收起'}" aria-label="${node.collapsed ? '展开' : '收起'}">${caret}</button>
        <span class="outline-text" title="${esc(node.text)}">${esc(node.text || '(空)')}</span>
        ${node.note ? '<span class="outline-note-dot" title="有备注"></span>' : ''}
        ${kids ? `<span class="outline-count">${kids}</span>` : ''}
      </div>`;
    })
    .join('');

  if (!visible.length) {
    panel.innerHTML = '<p class="sidebar-empty">大纲里没有匹配的节点</p>';
  }
}

/** 切换侧栏内容：导图列表 / 大纲。 */
function setSidebarTab(tab) {
  state.sidebarTab = tab === 'outline' ? 'outline' : 'maps';
  const isMaps = state.sidebarTab === 'maps';
  $('#tab-maps').classList.toggle('is-active', isMaps);
  $('#tab-outline').classList.toggle('is-active', !isMaps);
  $('#tab-maps').setAttribute('aria-selected', isMaps ? 'true' : 'false');
  $('#tab-outline').setAttribute('aria-selected', isMaps ? 'false' : 'true');
  $('#map-search-wrap').hidden = !isMaps;
  $('#outline-search-wrap').hidden = isMaps;
  $('#tag-filter').hidden = !isMaps || !(state.boot?.tags ?? []).length;
  $('#map-list').hidden = !isMaps;
  $('#sidebar-empty').hidden = !isMaps || state.maps.length > 0;
  $('#outline-panel').hidden = isMaps || !state.doc;
  $('#outline-empty').hidden = isMaps || !!state.doc;
  if (isMaps) renderMapList();
  else renderOutline();
}

/** 一次 op 之后只更新侧栏当前条目的 rev/节点数，避免整表重绘。 */
function syncMapEntry(doc) {
  const entry = state.maps.find((map) => map.slug === state.slug);
  if (!entry) {
    renderMapList();
    return;
  }
  entry.title = doc.title;
  entry.rev = doc.rev;
  entry.nodes = doc.nodes.length;
  entry.updatedAt = doc.updatedAt;
  entry.tags = doc.tags ?? [];
  const item = $(`#map-list .map-item[data-slug="${CSS.escape(state.slug)}"]`);
  if (!item) {
    renderMapList();
    return;
  }
  item.querySelector('.map-item-title').textContent = doc.title;
  item.querySelector('.rev').textContent = `r${doc.rev}`;
  item.querySelector('.map-nodes').textContent = `${doc.nodes.length} 节点`;
  item.querySelector('.map-time').textContent = formatTime(doc.updatedAt);
}

function isInspectorTyping() {
  const active = document.activeElement;
  return !!active && !!active.closest?.('#inspector') && active.matches('input, textarea, select');
}

function renderInspector(force = false) {
  if (!force && isInspectorTyping()) return;
  const body = $('#inspector-body');
  if (!state.doc) {
    body.innerHTML = `
      <div class="insp-empty">
        <div class="insp-empty-mark">${ICON.leaf}</div>
        <p class="insp-empty-title">还没有打开导图</p>
        <p>从左侧选择一张导图，或新建一张。选中节点后，这里会出现文字、备注、颜色、链接和结构操作。</p>
      </div>`;
    return;
  }
  const node = state.selectedId ? getNode(state.doc, state.selectedId) : null;
  body.innerHTML = node ? nodeInspectorHtml(node) : emptyInspectorHtml();
}

function emptyInspectorHtml() {
  const stats = docStats(state.doc);
  return `
    <div class="insp-empty">
      <div class="insp-empty-mark">${ICON.cursor}</div>
      <p class="insp-empty-title">选择一个节点开始编辑</p>
      <p>点击画布上的节点查看属性；双击进入行内编辑，拖拽节点可以换一个父节点。</p>
      <div class="insp-empty-hints">
        <div><kbd>Tab</kbd><span>加子节点</span></div>
        <div><kbd>Enter</kbd><span>加同级节点</span></div>
        <div><kbd>F2</kbd><span>编辑选中节点</span></div>
        <div><kbd>⌘Z</kbd><span>撤销上一步</span></div>
      </div>
      <div class="insp-doc">
        <div class="insp-doc-title">${esc(state.doc.title)}</div>
        <div class="insp-doc-meta">${stats.nodes} 个节点 · ${stats.edges} 条关联线 · 最大层级 ${stats.maxDepth + 1}</div>
      </div>
    </div>`;
}

function linkRowHtml(link, index) {
  const kind = KIND_LABELS[link.kind] ?? '链接';
  return `
    <div class="link-row">
      <button type="button" class="link-chip" data-act="link-open" data-index="${index}" title="${esc(link.kind)}: ${esc(link.target)}">
        <span class="badge badge-${esc(link.kind ?? 'file')}">${kind}</span>
        <span class="link-text">
          <span class="link-label">${esc(link.label || basename(link.target))}</span>
          <span class="link-target">${esc(link.target)}</span>
        </span>
      </button>
      <div class="link-row-actions">
        <button type="button" class="icon-btn xs" data-act="link-edit" data-index="${index}" title="编辑链接">${ICON.pencil}</button>
        <button type="button" class="icon-btn xs" data-act="link-del" data-index="${index}" title="删除链接">${ICON.x}</button>
      </div>
    </div>`;
}

function linkFormHtml() {
  const editing = state.linkEditIndex != null;
  const draft = state.linkDraft;
  const guessed = draft.target ? guessLinkKind(draft.target) : '';
  return `
    <div class="link-form">
      <div class="form-row">
        <select class="input" id="link-kind" aria-label="链接类型">
          <option value="auto"${draft.kind === 'auto' ? ' selected' : ''}>自动识别</option>
          <option value="file"${draft.kind === 'file' ? ' selected' : ''}>文件</option>
          <option value="url"${draft.kind === 'url' ? ' selected' : ''}>网址</option>
          <option value="code"${draft.kind === 'code' ? ' selected' : ''}>代码</option>
        </select>
        <span class="guess" id="link-guess">${draft.kind === 'auto' && guessed ? `识别为${KIND_LABELS[guessed]}` : ''}</span>
      </div>
      <input class="input" id="link-target" placeholder="粘贴路径或网址…" value="${esc(draft.target)}" autocomplete="off" spellcheck="false">
      <input class="input" id="link-label" placeholder="标签（可选）" value="${esc(draft.label)}" autocomplete="off">
      <div class="form-row">
        <button type="button" class="btn ghost sm" data-act="link-clip" title="读取剪贴板里的路径或网址">读取剪贴板</button>
        <span class="form-row-spacer"></span>
        ${editing ? '<button type="button" class="btn ghost sm" data-act="link-cancel">取消修改</button>' : ''}
        <button type="button" class="btn primary sm" data-act="link-add">${editing ? '保存链接' : '添加链接'}</button>
      </div>
    </div>`;
}

function nodeInspectorHtml(node) {
  const links = node.links ?? [];
  const kids = childrenOf(state.doc, node.id).length;
  const depth = nodeDepth(state.doc, node.id);
  return `
    <div class="insp-scroll">
      <section class="field">
        <label class="lab" for="insp-text">文本</label>
        <input class="input" id="insp-text" value="${esc(node.text)}" maxlength="1000" autocomplete="off">
      </section>
      <section class="field">
        <label class="lab" for="insp-note">备注</label>
        <textarea class="input textarea" id="insp-note" rows="3" placeholder="补充说明、待办、出处…">${esc(node.note ?? '')}</textarea>
      </section>
      <section class="field">
        <div class="color-head">
          <span class="lab">颜色</span>
          <div class="seg mini" id="style-scope" role="group" aria-label="颜色作用范围">
            <button type="button" class="seg-btn${state.styleScope === 'node' ? ' is-active' : ''}" data-scope="node" aria-pressed="${state.styleScope === 'node' ? 'true' : 'false'}" title="只改这个节点">本节点</button>
            <button type="button" class="seg-btn${state.styleScope === 'subtree' ? ' is-active' : ''}" data-scope="subtree" aria-pressed="${state.styleScope === 'subtree' ? 'true' : 'false'}" title="连同所有子节点一起改">含子节点</button>
          </div>
        </div>
        ${STYLE_FIELDS.map((field) => {
          const current = node[field.key] ?? '';
          return `<div class="color-row">
            <span class="color-label" title="${field.hint}">${field.label}</span>
            <div class="swatches sm">
              ${field.presets
                .map(
                  (color) =>
                    `<button type="button" class="swatch${current === color.value ? ' is-active' : ''}" style="--sw:${color.value}" data-act="style" data-field="${field.key}" data-value="${color.value}" title="${field.label}：${color.name}"></button>`,
                )
                .join('')}
              <label class="swatch custom${current && !field.presets.some((color) => color.value === current) ? ' is-active' : ''}" title="自定义颜色">
                <input type="color" data-act="style-custom" data-field="${field.key}" value="${current || (field.key === 'color' ? '#e8f0fe' : field.key === 'textColor' ? '#1f2937' : '#64748b')}">
              </label>
              <button type="button" class="swatch clear${current ? '' : ' is-active'}" data-act="style" data-field="${field.key}" data-value="" title="清除${field.label}颜色">${ICON.slash}</button>
            </div>
          </div>`;
        }).join('')}
        ${state.styleScope === 'subtree' ? '<p class="color-hint">颜色、字号、字体会应用到该节点和它的所有子节点；框宽高只改这个节点。</p>' : ''}
      </section>
      <section class="field">
        <span class="lab">字体与尺寸</span>
        <div class="type-grid">
          <label class="type-cell">
            <span class="type-label">字号</span>
            <select class="input select" data-act="font-size">
              ${FONT_SIZE_CHOICES.map(
                (size) =>
                  `<option value="${size}"${(node.fontSize ?? 0) === size ? ' selected' : ''}>${size ? `${size}px` : '自动'}</option>`,
              ).join('')}
            </select>
          </label>
          <label class="type-cell">
            <span class="type-label">字体</span>
            <select class="input select" data-act="font-family">
              ${FONT_CHOICES.map(
                (item) => `<option value="${item.key}"${(node.font ?? '') === item.key ? ' selected' : ''}>${item.label}</option>`,
              ).join('')}
            </select>
          </label>
          <label class="type-cell">
            <span class="type-label">框宽</span>
            <input class="input" type="number" min="44" max="600" step="4" placeholder="自动" value="${node.boxWidth ?? ''}" data-act="box-size" data-field="boxWidth">
          </label>
          <label class="type-cell">
            <span class="type-label">框高</span>
            <input class="input" type="number" min="24" max="500" step="4" placeholder="自动" value="${node.boxHeight ?? ''}" data-act="box-size" data-field="boxHeight">
          </label>
        </div>
        <p class="color-hint">字号和字体跟随上面的作用范围；框宽高只对这个节点生效（各节点文字长度不一样）。</p>
      </section>
      <section class="block">
        <div class="block-head"><span class="lab">链接</span><span class="count">${links.length}</span></div>
        <div class="link-list">
          ${links.length ? links.map((link, index) => linkRowHtml(link, index)).join('') : '<p class="link-empty">还没有链接。可以指向项目文件、代码行或网址。</p>'}
        </div>
        ${linkFormHtml()}
      </section>
      <section class="block">
        <span class="lab">结构</span>
        <div class="struct-grid">
          <button type="button" class="btn sm" data-act="add-child">加子节点</button>
          <button type="button" class="btn sm" data-act="add-sibling"${node.parent ? '' : ' disabled title="根节点没有同级"'}>加同级</button>
          <button type="button" class="btn sm" data-act="move-up"${node.parent ? '' : ' disabled'}>上移</button>
          <button type="button" class="btn sm" data-act="move-down"${node.parent ? '' : ' disabled'}>下移</button>
          <button type="button" class="btn sm" data-act="toggle-collapse"${kids ? '' : ' disabled'}>${node.collapsed ? '展开' : '收起'}</button>
          <button type="button" class="btn sm danger" data-act="remove-node"${node.parent ? '' : ' disabled title="根节点不能删除"'}>删除节点</button>
        </div>
      </section>
      <section class="meta-block">
        <div class="meta-row"><span>节点 ID</span><button type="button" class="id-chip" data-act="copy-id" title="点击复制节点 ID">${esc(node.id)}</button></div>
        <div class="meta-row"><span>层级 / 子节点</span><span>第 ${depth + 1} 层 · ${kids} 个子节点</span></div>
      </section>
    </div>`;
}

function renderStatusbar() {
  $('#status-maps').textContent = `${state.maps.length} 张导图`;
  const relative = state.boot?.relativeMapsDir ?? '—';
  const pathLabel = state.boot?.mapsDirIsAbsolute ? `${relative}（绝对路径）` : relative;
  $('#status-path').textContent = pathLabel;
  $('#status-path').title = state.boot?.mapsDir ?? '';
  const node = state.doc && state.selectedId ? getNode(state.doc, state.selectedId) : null;
  $('#status-node').textContent = node ? truncate(node.text, 30) : state.doc ? '未选择节点' : '未打开导图';
  $('#status-rev').textContent = state.doc ? `rev ${state.rev}` : '—';
  $('#status-version').textContent = `v${state.boot?.version ?? '0.0.0'}`;
}

function renderAll({ fit = false } = {}) {
  renderTopbar();
  renderTagFilter();
  renderMapList();
  renderCanvas({ fit });
  renderInspector(true);
  renderStatusbar();
  renderOutline();
}

/* ==========================================================================
   6. 画布交互
   ========================================================================== */

function svgPoint(event) {
  const svg = $('#canvas-stage svg');
  if (!svg || !state.layout) return null;
  const rect = svg.getBoundingClientRect();
  const scale = rect.width / state.layout.width || 1;
  return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
}

/** 点是否落在节点右侧/左侧的 +/− 圆点上。 */
function toggleHitTest(node, point) {
  if (!point || !node.expandable) return false;
  const cx = node.side === 'left' ? node.x - 9 : node.x + node.width + 9;
  const cy = node.y + node.height / 2;
  return Math.hypot(point.x - cx, point.y - cy) <= 12;
}

function nodeIdAtPoint(clientX, clientY) {
  const element = document.elementFromPoint(clientX, clientY);
  const group = element?.closest?.('g[data-node-id]');
  return group?.dataset.nodeId ?? null;
}

function zoomAtPoint(clientX, clientY, factor) {
  if (!state.doc) return;
  const viewport = $('#canvas-viewport');
  const rect = viewport.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const next = clamp(state.zoom * factor, ZOOM_MIN, ZOOM_MAX);
  if (next === state.zoom) return;
  const wx = (mx - state.pan.x) / state.zoom;
  const wy = (my - state.pan.y) / state.zoom;
  state.pan.x = mx - wx * next;
  state.pan.y = my - wy * next;
  state.zoom = next;
  applyTransform();
}

function zoomCentered(factor) {
  const rect = $('#canvas-viewport').getBoundingClientRect();
  zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

function clearDropTarget() {
  for (const group of $$('#canvas-stage g[data-node-id].is-drop-target')) group.classList.remove('is-drop-target');
}

function setDropTarget(id) {
  const drag = state.drag;
  if (drag.dropId === id) return;
  clearDropTarget();
  drag.dropId = id;
  if (!id) return;
  const group = $(`#canvas-stage g[data-node-id="${CSS.escape(id)}"]`);
  if (group) group.classList.add('is-drop-target');
}

function showDragHint(clientX, clientY, targetId) {
  const hint = $('#drag-hint');
  if (!targetId) {
    hint.hidden = true;
    return;
  }
  const target = getNode(state.doc, targetId);
  hint.textContent = target ? `移到「${truncate(target.text, 16)}」下` : '松开以移动';
  hint.style.left = `${clientX}px`;
  hint.style.top = `${clientY}px`;
  hint.hidden = false;
}

function isDescendantOf(ancestorId, nodeId) {
  let cursor = getNode(state.doc, nodeId);
  const seen = new Set();
  while (cursor && cursor.parent != null && !seen.has(cursor.id)) {
    if (cursor.parent === ancestorId) return true;
    seen.add(cursor.id);
    cursor = getNode(state.doc, cursor.parent);
  }
  return false;
}

function onCanvasPointerDown(event) {
  if (event.button !== 0 || !state.doc) return;
  closeExportMenu();
  const drag = state.drag;
  drag.startX = event.clientX;
  drag.startY = event.clientY;
  drag.originX = state.pan.x;
  drag.originY = state.pan.y;
  drag.moved = false;
  drag.dropId = null;
  drag.pointerId = event.pointerId;

  const group = event.target.closest?.('g[data-node-id]');
  const nodeId = group?.dataset.nodeId ?? null;
  const viewport = $('#canvas-viewport');

  if (nodeId) {
    const layoutNode = getLayoutNode(nodeId);
    if (layoutNode && toggleHitTest(layoutNode, svgPoint(event))) {
      drag.mode = 'toggle';
      toggleCollapse(nodeId);
      return;
    }
    drag.mode = 'node';
    drag.nodeId = nodeId;
    if (state.selectedId !== nodeId) selectNode(nodeId);
    try {
      viewport.setPointerCapture(event.pointerId);
    } catch {
      /* 忽略 */
    }
    return;
  }

  drag.mode = 'pan';
  try {
    viewport.setPointerCapture(event.pointerId);
  } catch {
    /* 忽略 */
  }
}

function onCanvasPointerMove(event) {
  const drag = state.drag;
  if (drag.mode === 'pan') {
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > 3) {
      drag.moved = true;
      $('#canvas-viewport').classList.add('is-panning');
    }
    if (!drag.moved) return;
    state.pan.x = drag.originX + dx;
    state.pan.y = drag.originY + dy;
    applyTransform();
    return;
  }

  if (drag.mode !== 'node' || !drag.nodeId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) > 6) {
    drag.moved = true;
    $('#canvas-viewport').classList.add('is-dragging');
  }
  if (!drag.moved) return;

  const node = getNode(state.doc, drag.nodeId);
  const candidate = nodeIdAtPoint(event.clientX, event.clientY);
  const valid = !!candidate && candidate !== drag.nodeId && !!node?.parent && !isDescendantOf(drag.nodeId, candidate);
  setDropTarget(valid ? candidate : null);
  showDragHint(event.clientX, event.clientY, valid ? candidate : null);
}

function onCanvasPointerUp(event) {
  const drag = state.drag;
  const mode = drag.mode;
  const moved = drag.moved;
  const nodeId = drag.nodeId;
  const dropId = drag.dropId;
  drag.mode = null;
  drag.pointerId = null;
  drag.nodeId = null;
  drag.moved = false;

  const viewport = $('#canvas-viewport');
  viewport.classList.remove('is-panning', 'is-dragging');
  $('#drag-hint').hidden = true;
  clearDropTarget();
  try {
    if (event?.pointerId != null) viewport.releasePointerCapture(event.pointerId);
  } catch {
    /* 忽略 */
  }

  if (mode === 'node' && moved) {
    if (nodeId && dropId) moveNodeTo(nodeId, dropId);
    return;
  }
  if (mode === 'pan' && !moved) {
    // 点空白：取消选中
    if (state.selectedId) {
      state.selectedId = null;
      applySelectionClass();
      renderInspector(true);
      renderStatusbar();
    }
  }
}

function onCanvasWheel(event) {
  if (!state.doc) return;
  event.preventDefault();
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
  zoomAtPoint(event.clientX, event.clientY, Math.exp(-delta * 0.0015));
}

function onCanvasDblClick(event) {
  if (!state.doc) return;
  const id = nodeIdAtPoint(event.clientX, event.clientY);
  if (id) {
    selectNode(id);
    startEdit(id);
    return;
  }
  fitView();
}

/* ---- 行内编辑 ---- */

function startEdit(id) {
  if (!state.doc) return;
  const layoutNode = getLayoutNode(id);
  const node = getNode(state.doc, id);
  if (!layoutNode || !node) return;
  if (state.editingId && state.editingId !== id) commitEdit();
  state.editingId = id;

  const area = document.createElement('textarea');
  area.className = 'node-editor';
  area.value = node.text;
  area.spellcheck = false;
  area.setAttribute('aria-label', '编辑节点文字');
  $('#editor-layer').appendChild(area);
  positionEditor(area, layoutNode);
  area.focus();
  area.select();
  area.addEventListener('keydown', onEditorKeydown);
  area.addEventListener('blur', () => commitEdit());
}

function positionEditor(area, node) {
  const svg = $('#canvas-stage svg');
  if (!svg) return;
  const svgRect = svg.getBoundingClientRect();
  const areaRect = $('#canvas-area').getBoundingClientRect();
  const scale = svgRect.width / state.layout.width || state.zoom;
  area.style.left = `${svgRect.left - areaRect.left + node.x * scale}px`;
  area.style.top = `${svgRect.top - areaRect.top + node.y * scale}px`;
  area.style.width = `${Math.max(96, node.width * scale)}px`;
  area.style.height = `${Math.max(30, node.height * scale)}px`;
  area.style.fontSize = `${node.fontSize * scale}px`;
  area.style.lineHeight = `${(node.lineHeight ?? node.fontSize * 1.45) * scale}px`;
  area.style.padding = `${Math.max(4, node.paddingY * scale)}px ${Math.max(8, node.paddingX * scale)}px`;
  area.style.borderRadius = `${node.radius * scale}px`;
}

function onEditorKeydown(event) {
  event.stopPropagation();
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    commitEdit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    commitEdit({ cancel: true });
  } else if (event.key === 'Tab') {
    event.preventDefault();
    commitEdit();
  }
}

async function commitEdit({ cancel = false } = {}) {
  const id = state.editingId;
  if (!id) return;
  state.editingId = null;
  const area = $('#editor-layer textarea');
  const value = area?.value ?? '';
  area?.remove();
  if (cancel || !state.doc) return;
  const node = getNode(state.doc, id);
  if (!node) return;
  const text = value.trim();
  if (!text || text === node.text) return;
  await runOps([{ op: 'updateNode', id, text }], { label: '编辑文字' });
}

/* ==========================================================================
   7. 文档操作
   ========================================================================== */

let opChain = Promise.resolve();

function runOps(ops, options = {}) {
  const task = opChain.then(() => executeOps(ops, options));
  opChain = task.catch(() => undefined);
  return task;
}

async function executeOps(ops, { label = '编辑', silent = false } = {}) {
  if (!state.slug || !state.doc) return null;
  state.undo.push({ doc: clone(state.doc), label });
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  state.redo.length = 0;
  state.pendingOps += 1;
  try {
    const result = await api(`/api/maps/${encodeURIComponent(state.slug)}/ops`, {
      method: 'POST',
      body: { ops, by: 'user', summary: label },
    });
    applyServerDoc(result.doc);
    return result.results ?? [];
  } catch (error) {
    state.undo.pop();
    if (error.code === 'conflict' && error.payload?.current) {
      applyServerDoc(error.payload.current);
      toast('导图已被外部修改，已载入最新版本', { tone: 'warn' });
    } else if (!silent) {
      toast(error.message, { tone: 'error' });
    }
    return null;
  } finally {
    state.pendingOps -= 1;
    renderTopbar();
    if (state.externalSignal) {
      state.externalSignal = false;
      scheduleExternalCheck();
    }
  }
}

function applyServerDoc(doc, { fit = false } = {}) {
  if (!doc) return;
  state.doc = doc;
  state.rev = doc.rev;
  if (!state.selectedId || !getNode(doc, state.selectedId)) state.selectedId = rootId(doc);
  applyTheme(currentTheme());
  renderCanvas({ fit });
  renderTopbar();
  renderInspector();
  renderStatusbar();
  renderOutline();
  syncMapEntry(doc);
  document.title = `${doc.title} · mindleaf`;
}

async function undo() {
  if (!state.doc) return;
  const entry = state.undo.pop();
  if (!entry) {
    toast('没有可撤销的操作', { tone: 'warn' });
    return;
  }
  const current = clone(state.doc);
  try {
    const result = await api(`/api/maps/${encodeURIComponent(state.slug)}`, {
      method: 'PUT',
      body: { doc: entry.doc, force: true, summary: `撤销：${entry.label}` },
    });
    state.redo.push({ doc: current, label: entry.label });
    applyServerDoc(result.doc);
    toast(`已撤销：${entry.label}`, { tone: 'ok' });
  } catch (error) {
    state.undo.push(entry);
    toast(error.message, { tone: 'error' });
  }
}

async function redo() {
  if (!state.doc) return;
  const entry = state.redo.pop();
  if (!entry) {
    toast('没有可重做的操作', { tone: 'warn' });
    return;
  }
  const current = clone(state.doc);
  try {
    const result = await api(`/api/maps/${encodeURIComponent(state.slug)}`, {
      method: 'PUT',
      body: { doc: entry.doc, force: true, summary: `重做：${entry.label}` },
    });
    state.undo.push({ doc: current, label: entry.label });
    applyServerDoc(result.doc);
    toast(`已重做：${entry.label}`, { tone: 'ok' });
  } catch (error) {
    state.redo.push(entry);
    toast(error.message, { tone: 'error' });
  }
}

function selectNode(id, { reveal = false } = {}) {
  if (!state.doc || !getNode(state.doc, id)) return;
  state.selectedId = id;
  applySelectionClass();
  renderInspector(true);
  renderStatusbar();
  if (reveal) ensureNodeVisible(id);
  if (isMobile()) $('#app').classList.remove('inspector-collapsed');
}

async function addChild(parentId = state.selectedId || rootId(state.doc)) {
  if (!state.doc) return;
  const parent = getNode(state.doc, parentId) ?? getNode(state.doc, rootId(state.doc));
  if (!parent) return;
  const results = await runOps([{ op: 'addNode', parent: parent.id, text: '新节点' }], { label: '添加子节点' });
  const created = results?.[0];
  if (created?.id) {
    selectNode(created.id);
    startEdit(created.id);
  }
}

async function addSibling() {
  const node = state.doc && getNode(state.doc, state.selectedId);
  if (!node) return;
  if (!node.parent) {
    addChild(node.id);
    return;
  }
  const siblings = childrenOf(state.doc, node.parent);
  const index = siblings.findIndex((sibling) => sibling.id === node.id);
  const results = await runOps([{ op: 'addNode', parent: node.parent, position: index + 1, text: '新节点' }], { label: '添加同级节点' });
  const created = results?.[0];
  if (created?.id) {
    selectNode(created.id);
    startEdit(created.id);
  }
}

async function deleteSelected() {
  const node = state.doc && getNode(state.doc, state.selectedId);
  if (!node) return;
  if (!node.parent) {
    toast('根节点不能删除', { tone: 'warn' });
    return;
  }
  const children = childrenOf(state.doc, node.id).length;
  if (children) {
    const confirmed = await askConfirm({
      title: '删除这个分支？',
      message: `「${truncate(node.text, 24)}」及其 ${children} 个子节点会被一起删除，可以用 ⌘Z 撤销。`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
  }
  const parentId = node.parent;
  const results = await runOps([{ op: 'removeNode', id: node.id }], { label: '删除节点' });
  if (!results) return;
  selectNode(parentId);
  toast('已删除节点', { tone: 'ok', action: { label: '撤销', run: undo } });
}

async function reorderSelected(direction) {
  const node = state.doc && getNode(state.doc, state.selectedId);
  if (!node?.parent) return;
  const before = childrenOf(state.doc, node.parent)
    .map((sibling) => sibling.id)
    .join(',');
  const results = await runOps([{ op: 'reorderNode', id: node.id, direction }], { label: direction === 'up' ? '上移节点' : '下移节点' });
  if (!results) return;
  const after = childrenOf(state.doc, getNode(state.doc, node.id)?.parent)
    .map((sibling) => sibling.id)
    .join(',');
  if (before === after) toast(direction === 'up' ? '已经是第一个了' : '已经是最后一个了', { tone: 'warn' });
}

async function moveNodeTo(nodeId, parentId) {
  const node = getNode(state.doc, nodeId);
  const parent = getNode(state.doc, parentId);
  if (!node || !parent) return;
  if (node.parent === parentId) return;
  const results = await runOps([{ op: 'moveNode', id: nodeId, parent: parentId }], { label: '移动节点' });
  if (results) {
    selectNode(nodeId);
    toast(`已移到「${truncate(parent.text, 18)}」下`, { tone: 'ok', action: { label: '撤销', run: undo } });
  }
}

async function toggleCollapse(id) {
  const node = state.doc && getNode(state.doc, id);
  if (!node) return;
  if (!childrenOf(state.doc, id).length) {
    toast('这个节点还没有子节点', { tone: 'warn' });
    return;
  }
  await runOps([{ op: 'updateNode', id, collapsed: !node.collapsed }], { label: node.collapsed ? '展开节点' : '收起节点' });
}

function moveSelection(delta) {
  const node = state.doc && getNode(state.doc, state.selectedId);
  if (!node?.parent) return;
  const siblings = childrenOf(state.doc, node.parent);
  const index = siblings.findIndex((sibling) => sibling.id === node.id);
  const next = siblings[index + delta];
  if (next) selectNode(next.id, { reveal: true });
}

async function selectParentNode() {
  const node = state.doc && getNode(state.doc, state.selectedId);
  if (node?.parent) selectNode(node.parent, { reveal: true });
}

async function selectFirstChildNode() {
  const node = state.doc && getNode(state.doc, state.selectedId);
  if (!node) return;
  const children = childrenOf(state.doc, node.id);
  if (!children.length) return;
  if (node.collapsed) await toggleCollapse(node.id);
  selectNode(children[0].id, { reveal: true });
}

async function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  if (!state.doc) {
    renderTopbar();
    renderCanvas();
    return;
  }
  const results = await runOps([{ op: 'setDoc', theme: next }], { label: '切换主题' });
  if (!results) applyTheme(currentTheme());
}

async function setLayout(layout) {
  if (!state.doc || state.doc.settings?.layout === layout) return;
  const results = await runOps([{ op: 'setDoc', layout }], { label: `布局：${LAYOUT_LABELS[layout] ?? layout}` });
  if (results) renderCanvas({ fit: true });
}

/* ---------- 标签编辑 ---------- */

let tagsDialogSlug = null;

function renderTagSuggestions(current) {
  const box = $('#tag-suggest');
  const all = (state.boot?.tags ?? []).map((item) => item.tag);
  const chosen = current.map((tag) => tag.toLowerCase());
  const rest = all.filter((tag) => !chosen.includes(tag.toLowerCase()));
  if (!rest.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `<span class="hint">已有标签，点一下加上：</span>${rest
    .map((tag) => `<button type="button" class="tag-chip" data-suggest="${esc(tag)}">${esc(tag)}</button>`)
    .join('')}`;
}

function openTagsDialog(slug) {
  const target = slug ?? state.slug;
  if (!target) return;
  const entry = state.maps.find((map) => map.slug === target);
  const current = target === state.slug ? state.doc?.tags ?? [] : entry?.tags ?? [];
  tagsDialogSlug = target;
  $('#tags-target').textContent = `「${entry?.title ?? target}」`;
  $('#tags-input').value = current.join(', ');
  $('#tags-error').hidden = true;
  renderTagSuggestions(current);
  openDialog($('#dlg-tags'));
  const input = $('#tags-input');
  input.focus();
  input.select();
}

/** 直接改某张图的标签；不在当前打开的图上也能改。 */
async function saveMapTags(slug, tags) {
  const result = await api(`/api/maps/${encodeURIComponent(slug)}/ops`, {
    method: 'POST',
    body: { ops: [{ op: 'setDoc', tags }], by: 'user', summary: tags.length ? `标签：${tags.join('、')}` : '清空标签' },
  });
  await refreshState();
  if (slug === state.slug) {
    state.doc = result.doc;
    state.rev = result.doc.rev;
    renderStatusbar();
    renderOutline();
  }
  renderTagFilter();
  renderMapList();
}

async function renameDoc(title) {
  if (!state.doc) return null;
  return runOps([{ op: 'setDoc', title }], { label: '重命名导图' });
}

/* ==========================================================================
   8. 面板 / 对话框
   ========================================================================== */

function openDialog(dialog) {
  if (!dialog || dialog.open) return;
  dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}

function showFormError(selector, message) {
  const element = $(selector);
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

function setFormBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.dataset.label || button.textContent;
    button.disabled = true;
    button.textContent = label;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.label || label;
  }
}

function toast(message, { tone = 'info', action = null, timeout = 3400 } = {}) {
  const container = $('#toasts');
  if (!container) return;
  while (container.children.length >= 4) container.firstElementChild.remove();
  const element = document.createElement('div');
  element.className = `toast toast-${tone}`;
  element.innerHTML = '<span class="toast-dot" aria-hidden="true"></span><span class="toast-msg"></span>';
  element.querySelector('.toast-msg').textContent = message;
  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    element.classList.add('out');
    element.classList.remove('in');
    setTimeout(() => element.remove(), 200);
  };
  if (action) {
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      dismiss();
      action.run?.();
    });
    element.appendChild(button);
  }
  container.appendChild(element);
  requestAnimationFrame(() => element.classList.add('in'));
  if (timeout) timer = setTimeout(dismiss, timeout);
  return { dismiss };
}

/** 通用确认框，返回 Promise<boolean>。 */
let confirmResolve = null;

function askConfirm({ title, message, confirmText = '确定', danger = false }) {
  const dialog = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  const ok = $('#confirm-ok');
  ok.textContent = confirmText;
  ok.className = `btn ${danger ? 'danger' : 'primary'}`;
  return new Promise((resolve) => {
    confirmResolve = resolve;
    openDialog(dialog);
  });
}

function resetConfirm() {
  if (confirmResolve) {
    confirmResolve(false);
    confirmResolve = null;
  }
}

/* ---- 新建导图（模板向导） ---- */

async function ensureTemplates() {
  if (state.templates.length) return;
  try {
    const data = await api('/api/templates');
    state.templates = Array.isArray(data.templates) ? data.templates : [];
    state.templatesFailed = false;
  } catch {
    state.templates = [];
    state.templatesFailed = true;
  }
}

function selectedTemplate() {
  return state.templates.find((template) => template.id === state.wizard.templateId) ?? null;
}

function renderTemplateGrid() {
  const blank = { id: '', title: '空白导图', emoji: '✨', description: '从零开始，只放一个中心主题。', nodes: 1, maxDepth: 0, tags: [] };
  const items = [blank, ...state.templates];
  $('#tpl-grid').innerHTML = items
    .map(
      (template) => `
      <button type="button" class="tpl-card${template.id === state.wizard.templateId ? ' is-active' : ''}" role="option" aria-selected="${template.id === state.wizard.templateId}" data-tpl="${esc(template.id)}">
        <span class="tpl-emoji" aria-hidden="true">${esc(template.emoji || '🗂️')}</span>
        <span class="tpl-body">
          <span class="tpl-title">${esc(template.title)}</span>
          <span class="tpl-desc">${esc(template.description || '空白导图')}</span>
          <span class="tpl-meta">${template.id ? `${template.nodes} 个节点 · 层级 ${(template.maxDepth ?? 0) + 1}` : '空白'}</span>
          ${
            template.tags?.length
              ? `<span class="tpl-tags">${template.tags.slice(0, 3).map((tag) => `<span class="tpl-tag">${esc(tag)}</span>`).join('')}</span>`
              : ''
          }
        </span>
      </button>`,
    )
    .join('');
  $('#tpl-empty').hidden = !state.templatesFailed;
}

function selectTemplate(id) {
  state.wizard.templateId = id;
  for (const card of $$('#tpl-grid .tpl-card')) {
    const active = card.dataset.tpl === id;
    card.classList.toggle('is-active', active);
    card.setAttribute('aria-selected', active ? 'true' : 'false');
  }
}

function goWizardStep(step) {
  state.wizard.step = step;
  for (const panel of $$('.wizard-panel')) panel.hidden = Number(panel.dataset.panel) !== step;
  for (const badge of $$('.wstep')) badge.classList.toggle('is-active', Number(badge.dataset.step) === step);
  $('#btn-map-back').hidden = step === 1;
  $('#btn-map-next').hidden = step !== 1;
  $('#btn-map-create').hidden = step !== 2;
  $('#map-error').hidden = true;

  if (step === 2) {
    if (!state.wizard.titleTouched) {
      const template = selectedTemplate();
      $('#new-title').value = template ? template.title : '';
    }
    renderPickedTemplate();
    const input = $('#new-title');
    input.focus();
    input.select();
  }
}

function renderPickedTemplate() {
  const picked = $('#tpl-picked');
  const template = selectedTemplate();
  if (!template) {
    picked.innerHTML = `
      <span class="tpl-emoji" aria-hidden="true">✨</span>
      <span class="tpl-body">
        <span class="tpl-title">空白导图</span>
        <span class="tpl-desc">只有一个中心主题，随你发挥。</span>
      </span>`;
    $('#btn-tpl-preview').hidden = true;
    $('#tpl-preview').hidden = true;
    return;
  }
  picked.innerHTML = `
    <span class="tpl-emoji" aria-hidden="true">${esc(template.emoji || '🗂️')}</span>
    <span class="tpl-body">
      <span class="tpl-title">${esc(template.title)}</span>
      <span class="tpl-desc">${esc(template.description || '')}</span>
    </span>`;
  $('#btn-tpl-preview').hidden = false;
  $('#tpl-preview').hidden = true;
  $('#tpl-preview').textContent = '';
}

async function openNewMapDialog() {
  state.wizard = { step: 1, templateId: '', titleTouched: false };
  $('#new-title').value = '';
  if ($('#new-tags')) $('#new-tags').value = '';
  $('#map-error').hidden = true;
  await ensureTemplates();
  renderTemplateGrid();
  goWizardStep(1);
  openDialog($('#dlg-map'));
}

async function createMapFromWizard() {
  const template = selectedTemplate();
  const title = $('#new-title').value.trim() || template?.title || '未命名导图';
  const body = { title };
  if (template) body.template = template.id;
  const tags = parseTagInput($('#new-tags')?.value);
  if (tags.length) body.tags = tags;
  const button = $('#btn-map-create');
  setFormBusy(button, true, '创建中…');
  try {
    const created = await api('/api/maps', { method: 'POST', body });
    closeDialog($('#dlg-map'));
    await refreshState();
    await loadMap(created.slug, { fit: true });
    toast(template ? `已用「${template.title}」新建「${created.doc.title}」` : `已新建「${created.doc.title}」`, { tone: 'ok' });
  } catch (error) {
    showFormError('#map-error', error.message);
  } finally {
    setFormBusy(button, false, '创建导图');
  }
}

async function toggleTemplatePreview() {
  const preview = $('#tpl-preview');
  if (!preview.hidden) {
    preview.hidden = true;
    return;
  }
  const template = selectedTemplate();
  if (!template) return;
  preview.hidden = false;
  preview.textContent = '载入中…';
  try {
    const data = await api(`/api/templates/${encodeURIComponent(template.id)}`);
    preview.textContent = data.template?.markdown ?? '（模板内容为空）';
  } catch (error) {
    preview.textContent = `读取失败：${error.message}`;
  }
}

/* ---- 导入 Markdown ---- */

function openImportDialog() {
  $('#import-markdown').value = '';
  $('#import-title').value = '';
  $('#import-file-name').textContent = '未选择文件';
  $('#import-file').value = '';
  $('#import-error').hidden = true;
  openDialog($('#dlg-import'));
  setTimeout(() => $('#import-markdown').focus(), 30);
}

async function submitImport() {
  const markdown = $('#import-markdown').value;
  if (!markdown.trim()) {
    showFormError('#import-error', '请先粘贴 Markdown 内容或选择一个文件');
    return;
  }
  const title = $('#import-title').value.trim();
  const button = $('#form-import button[type="submit"]');
  setFormBusy(button, true, '导入中…');
  try {
    const result = await api('/api/maps/new/import', { method: 'POST', body: title ? { markdown, title } : { markdown } });
    closeDialog($('#dlg-import'));
    await refreshState();
    await loadMap(result.slug, { fit: true });
    toast(`已导入「${result.doc.title}」`, { tone: 'ok' });
  } catch (error) {
    showFormError('#import-error', error.message);
  } finally {
    setFormBusy(button, false, '导入');
  }
}

/* ---- 设置 ---- */

function fillSettings() {
  const boot = state.boot;
  $('#set-maps-dir').value = boot?.mapsDirIsAbsolute ? boot.mapsDir : boot?.relativeMapsDir ?? 'maps';
  $('#set-project-dir').textContent = boot?.projectDir ?? '—';
  $('#set-maps-abs').textContent = boot?.mapsDir ?? '—';
  $('#set-exports-dir').textContent = boot?.exportsDir ?? '—';
  $('#set-chromium').textContent = boot?.engines?.chromium ? '可用' : '未检测到';
  $('#set-png').textContent = boot?.engines?.png ? '可用' : '不可用';
  $('#set-pdf').textContent = boot?.engines?.pdf ? '可用' : '不可用';
  $('#set-version').textContent = boot ? `v${boot.version}` : '—';
  $('#settings-error').hidden = true;
}

function openSettingsDialog() {
  fillSettings();
  openDialog($('#dlg-settings'));
}

async function submitSettings() {
  const value = $('#set-maps-dir').value.trim();
  if (!value) {
    showFormError('#settings-error', '导图目录不能为空');
    return;
  }
  const button = $('#form-settings button[type="submit"]');
  setFormBusy(button, true, '保存中…');
  try {
    await api('/api/config', { method: 'PUT', body: { mapsDir: value } });
    closeDialog($('#dlg-settings'));
    await refreshState();
    if (state.slug && state.maps.some((map) => map.slug === state.slug)) {
      await loadMap(state.slug, { fit: false });
    } else if (state.maps.length) {
      await loadMap(state.maps[0].slug, { fit: true });
    } else {
      resetDoc();
    }
    toast('设置已保存', { tone: 'ok' });
  } catch (error) {
    showFormError('#settings-error', error.message);
  } finally {
    setFormBusy(button, false, '保存');
  }
}

/* ---- 重命名 ---- */

function openRenameDialog() {
  if (!state.doc) return;
  $('#rename-title').value = state.doc.title;
  $('#rename-error').hidden = true;
  openDialog($('#dlg-rename'));
  setTimeout(() => $('#rename-title').select(), 30);
}

async function submitRename() {
  const title = $('#rename-title').value.trim();
  if (!title) {
    showFormError('#rename-error', '标题不能为空');
    return;
  }
  const results = await renameDoc(title);
  if (results) {
    closeDialog($('#dlg-rename'));
    toast('已重命名', { tone: 'ok' });
  } else {
    showFormError('#rename-error', '重命名失败，请重试');
  }
}

/* ---- 文件 / 代码预览抽屉 ---- */

function openPreview(link) {
  const target = String(link?.target ?? '').trim();
  if (!target) return;
  const parsed = parseLinkTarget(target);
  const drawer = $('#preview-drawer');
  drawer.hidden = false;
  requestAnimationFrame(() => drawer.classList.add('is-open'));
  $('#preview-kind').textContent = KIND_LABELS[link.kind] ?? '文件';
  $('#preview-kind').className = `badge badge-${link.kind ?? 'file'}`;
  $('#preview-title').textContent = link.label || basename(parsed.path);
  $('#preview-path').textContent = target;
  $('#preview-path').title = target;
  $('#preview-body').innerHTML = '<div class="drawer-loading">读取中…</div>';
  state.preview = { path: parsed.path, abs: null, range: parsed.range };

  api(`/api/file?path=${encodeURIComponent(parsed.path)}`)
    .then((data) => {
      state.preview.abs = data.path ?? parsed.path;
      renderPreviewBody(data, parsed.range);
    })
    .catch((error) => {
      $('#preview-body').innerHTML = `<div class="drawer-error">${esc(error.message)}</div>`;
    });
}

function renderPreviewBody(data, range) {
  const body = $('#preview-body');
  if (!data || data.kind === 'binary') {
    body.innerHTML = `<div class="drawer-note">${esc(data?.message || '二进制文件，未预览')}${data?.size ? `（${formatBytes(data.size)}）` : ''}</div>`;
    return;
  }
  if (data.kind === 'dir') {
    const entries = [...(data.entries ?? [])].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    body.innerHTML = `<div class="dir-list">${entries
      .map(
        (entry) => `
        <button type="button" class="dir-item" ${entry.dir ? `data-path="${esc(`${data.path}/${entry.name}`)}"` : 'disabled'}>
          <span class="dir-icon" aria-hidden="true">${entry.dir ? '📁' : '📄'}</span>
          <span>${esc(entry.name)}</span>
          ${entry.dir ? '' : `<span class="dir-size">${formatBytes(entry.size)}</span>`}
        </button>`,
      )
      .join('')}</div>`;
    return;
  }

  const lines = String(data.content ?? '').split('\n');
  const limit = 3000;
  const shown = lines.slice(0, limit);
  const [start, end] = range ?? [0, 0];
  const rows = shown
    .map((line, index) => {
      const number = index + 1;
      const highlighted = start > 0 && number >= start && number <= end;
      return `<div class="code-line${highlighted ? ' is-hl' : ''}"><span class="code-ln">${number}</span><span class="code-tx">${esc(line) || ' '}</span></div>`;
    })
    .join('');
  body.innerHTML = `<div class="code-lines">${rows}</div>${
    lines.length > limit ? `<div class="drawer-note">文件较长，只显示前 ${limit} 行。</div>` : ''
  }`;
  const first = body.querySelector('.code-line.is-hl');
  if (first) first.scrollIntoView({ block: 'center' });
}

function closePreview() {
  const drawer = $('#preview-drawer');
  drawer.classList.remove('is-open');
  setTimeout(() => {
    drawer.hidden = true;
  }, 240);
  state.preview = { path: null, abs: null, range: null };
}

async function revealPreview() {
  const target = state.preview.abs || state.preview.path;
  if (!target) return;
  try {
    await api('/api/reveal', { method: 'POST', body: { path: target } });
    toast('已在 Finder 中显示', { tone: 'ok' });
  } catch (error) {
    toast(error.message, { tone: 'warn' });
  }
}

/* ---- 示例导图（客户端造 8 个节点） ---- */

async function createSampleMap() {
  try {
    let doc = createDoc({ title: '示例：项目计划', rootText: '项目计划', theme: currentTheme(), layout: 'both' });
    const add = (parent, text) => {
      const result = applyOps(doc, [{ op: 'addNode', parent, text }]);
      doc = result.doc;
      return result.results[0].id;
    };
    const background = add('root', '研究背景');
    add(background, '多模态表征');
    add(background, '弱监督数据');
    const method = add('root', '方法与实验');
    const align = add(method, '视觉-语言对齐');
    add(method, '消融实验');
    const writing = add('root', '写作与投稿');
    const graph = applyOps(doc, [
      { op: 'updateNode', id: align, note: '核心创新点：用一个轻量适配器对齐两路表征。' },
      {
        op: 'updateNode',
        id: align,
        links: [
          { kind: 'code', target: 'src/core/layout.mjs#L70-L120', label: '布局算法' },
          { kind: 'url', target: 'https://arxiv.org', label: 'arXiv' },
        ],
      },
      { op: 'addEdge', from: align, to: writing, label: '验证' },
    ]);
    doc = graph.doc;
    const created = await api('/api/maps', { method: 'POST', body: { title: doc.title } });
    await api(`/api/maps/${encodeURIComponent(created.slug)}`, { method: 'PUT', body: { doc, force: true } });
    await refreshState();
    await loadMap(created.slug, { fit: true });
    toast('已新建示例导图', { tone: 'ok' });
  } catch (error) {
    toast(`创建示例失败：${error.message}`, { tone: 'error' });
  }
}

/* ---- 复制 ---- */

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', { tone: 'ok' });
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      toast('已复制到剪贴板', { tone: 'ok' });
    } catch {
      toast('复制失败，请手动选择', { tone: 'warn' });
    }
    area.remove();
  }
}

/* ---- 检查器动作 ---- */

function commitInspectorText(value) {
  const node = state.doc && getNode(state.doc, state.selectedId);
  if (!node) return;
  const text = value.trim();
  if (!text || text === node.text) return;
  runOps([{ op: 'updateNode', id: node.id, text }], { label: '编辑文字' }).then(() => {
    const input = $('#insp-text');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
}

let noteTimer = null;

function scheduleNoteSave(value) {
  const id = state.selectedId;
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    noteTimer = null;
    saveNoteValue(id, value);
  }, 650);
}

function saveNoteValue(id, value) {
  const node = state.doc && getNode(state.doc, id);
  if (!node) return;
  if ((node.note ?? '') === value) return;
  runOps([{ op: 'updateNode', id, note: value }], { label: '编辑备注' });
}

function saveNoteNow(value) {
  if (noteTimer) {
    clearTimeout(noteTimer);
    noteTimer = null;
  }
  saveNoteValue(state.selectedId, value);
}

const STYLE_LABELS = { color: '模块颜色', textColor: '字体颜色', lineColor: '连线颜色' };

/** 改字号、字体、框宽高。字号和字体跟随作用范围，框尺寸只改当前节点。 */
async function updateTypography(field, value) {
  const node = state.doc && getNode(state.doc, state.selectedId);
  if (!node) return;
  const patch = { op: 'updateNode', id: node.id };
  if (field === 'fontSize') {
    patch.fontSize = Number(value) > 0 ? Number(value) : '';
    if (state.styleScope === 'subtree') patch.subtree = true;
  } else if (field === 'font') {
    patch.font = value || '';
    if (state.styleScope === 'subtree') patch.subtree = true;
  } else if (field === 'boxWidth' || field === 'boxHeight') {
    patch[field] = value === '' ? '' : Number(value);
  } else {
    return;
  }
  const labels = { fontSize: '字号', font: '字体', boxWidth: '框宽', boxHeight: '框高' };
  const scope = state.styleScope === 'subtree' && field !== 'boxWidth' && field !== 'boxHeight' ? '（含子节点）' : '';
  await runOps([patch], { label: `调整${labels[field] ?? '样式'}${scope}` });
}

/** 改一个颜色字段；点同一个色块再点一次等于清除。subtree 模式下连同子孙一起改。 */
async function updateStyle(field, value) {
  const node = state.doc && getNode(state.doc, state.selectedId);
  if (!node) return;
  const subtree = state.styleScope === 'subtree';
  // 本节点模式下点当前色 = 清除；子树模式不做切换判断（免得一半节点清一半没清）
  const next = !subtree && (node[field] ?? '') === value ? '' : value;
  const patch = { op: 'updateNode', id: node.id, [field]: next };
  if (subtree) patch.subtree = true;
  const label = `${next ? '设置' : '清除'}${STYLE_LABELS[field] ?? '颜色'}${subtree ? '（含子节点）' : ''}`;
  await runOps([patch], { label });
}

function beginLinkEdit(index) {
  const node = state.doc && getNode(state.doc, state.selectedId);
  const link = node?.links?.[index];
  if (!link) return;
  state.linkEditIndex = index;
  state.linkDraft = { kind: link.kind, target: link.target, label: link.label ?? '' };
  renderInspector(true);
  $('#link-target')?.focus();
}

function resetLinkForm() {
  state.linkEditIndex = null;
  state.linkDraft = { kind: 'auto', target: '', label: '' };
  renderInspector(true);
}

async function addLinkFromForm() {
  const node = state.doc && getNode(state.doc, state.selectedId);
  if (!node) return;
  const draft = state.linkDraft;
  const target = draft.target.trim();
  if (!target) {
    toast('先填写链接目标', { tone: 'warn' });
    $('#link-target')?.focus();
    return;
  }
  const link = { target };
  if (draft.kind !== 'auto') link.kind = draft.kind;
  if (draft.label.trim()) link.label = draft.label.trim();
  const links = [...(node.links ?? [])];
  const editing = state.linkEditIndex;
  if (editing != null && links[editing]) links[editing] = link;
  else links.push(link);
  const results = await runOps([{ op: 'updateNode', id: node.id, links }], { label: editing != null ? '修改链接' : '添加链接' });
  if (results) {
    state.linkEditIndex = null;
    state.linkDraft = { kind: 'auto', target: '', label: '' };
    renderInspector(true);
  }
}

async function deleteLink(index) {
  const node = state.doc && getNode(state.doc, state.selectedId);
  const link = node?.links?.[index];
  if (!node || !link) return;
  const links = [...node.links];
  links.splice(index, 1);
  const results = await runOps([{ op: 'updateNode', id: node.id, links }], { label: '删除链接' });
  if (results) {
    state.linkEditIndex = null;
    state.linkDraft = { kind: 'auto', target: '', label: '' };
    renderInspector(true);
  }
}

function openLinkByIndex(index) {
  const node = state.doc && getNode(state.doc, state.selectedId);
  const link = node?.links?.[index];
  if (!link) return;
  if (link.kind === 'url' || /^https?:/i.test(link.target)) {
    window.open(link.target, '_blank', 'noopener');
    return;
  }
  openPreview(link);
}

async function readClipboardIntoLink() {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) {
      toast('剪贴板是空的', { tone: 'warn' });
      return;
    }
    state.linkDraft.target = text;
    const input = $('#link-target');
    if (input) input.value = text;
    updateLinkGuess();
  } catch {
    toast('无法读取剪贴板，请直接粘贴到输入框', { tone: 'warn' });
  }
}

function updateLinkGuess() {
  const hint = $('#link-guess');
  if (!hint) return;
  if (state.linkDraft.kind !== 'auto' || !state.linkDraft.target) {
    hint.textContent = '';
    return;
  }
  hint.textContent = `识别为${KIND_LABELS[guessLinkKind(state.linkDraft.target)] ?? '文件'}`;
}

async function handleInspectorAction(act, element) {
  const node = state.doc && getNode(state.doc, state.selectedId);
  switch (act) {
    case 'add-child':
      addChild(node?.id);
      break;
    case 'add-sibling':
      addSibling();
      break;
    case 'move-up':
      reorderSelected('up');
      break;
    case 'move-down':
      reorderSelected('down');
      break;
    case 'remove-node':
      deleteSelected();
      break;
    case 'toggle-collapse':
      if (node) toggleCollapse(node.id);
      break;
    case 'copy-id':
      if (node) copyText(node.id);
      break;
    case 'style':
      updateStyle(element.dataset.field, element.dataset.value ?? '');
      break;
    case 'link-open':
      openLinkByIndex(Number(element.dataset.index));
      break;
    case 'link-edit':
      beginLinkEdit(Number(element.dataset.index));
      break;
    case 'link-del':
      deleteLink(Number(element.dataset.index));
      break;
    case 'link-add':
      addLinkFromForm();
      break;
    case 'link-cancel':
      resetLinkForm();
      break;
    case 'link-clip':
      readClipboardIntoLink();
      break;
    default:
      break;
  }
}

/* ==========================================================================
   9. 导出
   ========================================================================== */

function setExporting(value) {
  state.exporting = value;
  const button = $('#btn-export');
  button.disabled = value || !state.doc;
  button.classList.toggle('is-loading', value);
  for (const item of $$('#export-menu .menu-item')) item.disabled = value;
  renderTopbar();
}

function closeExportMenu() {
  const menu = $('#export-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  $('#btn-export').setAttribute('aria-expanded', 'false');
}

function toggleExportMenu(force) {
  const menu = $('#export-menu');
  const open = force === undefined ? menu.hidden : force;
  menu.hidden = !open;
  $('#btn-export').setAttribute('aria-expanded', open ? 'true' : 'false');
}

async function exportRaster(format) {
  if (!state.doc) return;
  setExporting(true);
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const layout = layoutDoc(state.doc, { direction: state.doc.settings?.layout ?? 'right', theme: currentTheme(), scale: 2 });
    const svg = renderSvg(layout, { background: true, title: state.doc.title, idPrefix: 'export' });
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext('2d');
    if (format === 'jpg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(image, 0, 0);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('生成图片失败'))), format === 'jpg' ? 'image/jpeg' : 'image/png', 0.94);
    });
    const name = `${fileBase(state.doc)}.${format}`;
    downloadBlob(blob, name);
    toast(`已导出 ${name} · ${formatBytes(blob.size)}`, { tone: 'ok' });
  } catch (error) {
    toast(`导出失败：${error.message}`, { tone: 'error' });
  } finally {
    setExporting(false);
  }
}

async function exportServer(format) {
  if (!state.doc || !state.slug) return;
  setExporting(true);
  try {
    const response = await fetch(`/api/maps/${encodeURIComponent(state.slug)}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format, name: state.doc.title, theme: currentTheme() }),
    });
    if (!response.ok) {
      let message = `导出失败（${response.status}）`;
      try {
        const data = await response.json();
        message = data.message || data.error || message;
      } catch {
        /* 忽略 */
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    const extension = format === 'md' ? 'md' : format;
    const name = `${fileBase(state.doc)}.${extension}`;
    downloadBlob(blob, name);
    toast(`已导出 ${name} · ${formatBytes(blob.size)}`, { tone: 'ok' });
  } catch (error) {
    toast(error.message, { tone: 'error' });
  } finally {
    setExporting(false);
  }
}

function printDoc() {
  if (!state.doc) return;
  const layout = layoutDoc(state.doc, { direction: state.doc.settings?.layout ?? 'right', theme: currentTheme() });
  const svg = renderSvg(layout, { background: true, title: state.doc.title });
  const win = window.open('', '_blank');
  if (!win) {
    toast('浏览器拦截了弹窗，请允许后重试', { tone: 'warn' });
    return;
  }
  win.document.open();
  win.document.write(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(state.doc.title)}</title><style>@page{margin:12mm}html,body{margin:0;background:#fff}svg{display:block;width:100%;height:auto}</style></head><body>${svg}</body></html>`,
  );
  win.document.close();
  setTimeout(() => {
    try {
      win.focus();
      win.print();
    } catch {
      /* 忽略 */
    }
  }, 400);
}

async function runExport(kind) {
  closeExportMenu();
  if (!state.doc || state.exporting) return;
  if (!state.slug) {
    toast('请先打开一张导图', { tone: 'warn' });
    return;
  }
  if (kind === 'png' || kind === 'jpg') {
    exportRaster(kind);
    return;
  }
  if (kind === 'pdf' && !state.boot?.engines?.chromium) {
    openDialog($('#dlg-pdf'));
    return;
  }
  exportServer(kind);
}

/* ==========================================================================
   10. 实时同步
   ========================================================================== */

function setSync(online) {
  state.syncOnline = online;
  const dot = $('#sync-dot');
  dot.classList.toggle('is-online', online);
  dot.classList.toggle('is-busy', !online);
  dot.title = online ? '实时同步：已连接' : '实时同步：离线（正在重连）';
}

function showBanner() {
  $('#external-banner').hidden = false;
}

function hideBanner() {
  $('#external-banner').hidden = true;
}

function isUserBusy() {
  if (state.editingId) return true;
  if (document.querySelector('dialog.modal[open]')) return true;
  const active = document.activeElement;
  return !!active && active.matches?.('input, textarea, select, [contenteditable="true"]');
}

function handleEvent(event) {
  if (!event?.type) return;
  if (['create', 'delete', 'save', 'ops', 'external'].includes(event.type)) scheduleListRefresh();
  if (!event.slug || event.slug !== state.slug) return;
  if (event.type === 'delete') {
    toast('当前导图已被外部删除', { tone: 'warn' });
    resetDoc();
    refreshState().catch(() => undefined);
    return;
  }
  if (state.pendingOps > 0) {
    state.externalSignal = true;
    return;
  }
  if (event.type !== 'external' && Number.isFinite(event.rev) && event.rev <= state.rev) return;
  scheduleExternalCheck();
}

const scheduleExternalCheck = debounce(() => checkExternalChange(), 350);
const scheduleListRefresh = debounce(() => refreshState().catch(() => undefined), 450);

async function checkExternalChange() {
  if (!state.slug || state.pendingOps > 0) return;
  let data;
  try {
    data = await api(`/api/maps/${encodeURIComponent(state.slug)}`);
  } catch {
    return;
  }
  if (!state.doc || data.doc.rev <= state.rev) {
    hideBanner();
    return;
  }
  if (isUserBusy()) {
    showBanner();
    return;
  }
  applyRemoteDoc(data.doc);
}

function applyRemoteDoc(doc) {
  if (!state.doc) {
    loadMap(state.slug, { fit: true }).catch(() => undefined);
    return;
  }
  state.selectedId = state.selectedId && getNode(doc, state.selectedId) ? state.selectedId : rootId(doc);
  hideBanner();
  applyServerDoc(doc);
  toast('已同步外部修改', { tone: 'ok', timeout: 2200 });
}

function connectEvents() {
  let source;
  try {
    source = new EventSource('/api/events');
  } catch {
    setSync(false);
    return;
  }
  source.onopen = () => setSync(true);
  source.onerror = () => setSync(false);
  source.onmessage = (message) => {
    try {
      handleEvent(JSON.parse(message.data));
    } catch {
      /* 忽略坏消息 */
    }
  };
}

/* ==========================================================================
   11. 数据加载 / 启动
   ========================================================================== */

async function refreshState() {
  const boot = await api('/api/state');
  state.boot = boot;
  state.maps = Array.isArray(boot.maps) ? boot.maps : [];
  renderTagFilter();
  renderMapList();
  renderStatusbar();
  renderTopbar();
  if (state.sidebarTab === 'outline') renderOutline();
}

async function loadMap(slug, { fit = false, preserveSelection = false, quiet = false } = {}) {
  try {
    const data = await api(`/api/maps/${encodeURIComponent(slug)}`);
    state.slug = data.slug ?? slug;
    state.doc = data.doc;
    state.rev = data.doc.rev;
    state.undo = [];
    state.redo = [];
    state.editingId = null;
    $('#editor-layer').innerHTML = '';
    state.linkEditIndex = null;
    state.linkDraft = { kind: 'auto', target: '', label: '' };
    state.selectedId =
      preserveSelection && state.selectedId && getNode(data.doc, state.selectedId) ? state.selectedId : rootId(data.doc);
    try {
      localStorage.setItem('mindleaf:lastSlug', state.slug);
    } catch {
      /* 忽略隐私模式 */
    }
    hideBanner();
    applyTheme(currentTheme());
    renderAll({ fit: fit || !preserveSelection });
    if (isMobile()) $('#app').classList.add('sidebar-collapsed');
    if (!quiet) renderTopbar();
  } catch (error) {
    toast(`打开导图失败：${error.message}`, { tone: 'error' });
    if (!state.doc) showEmptyError(error.message);
  }
}

function selectMap(slug) {
  if (slug === state.slug) {
    if (isMobile()) $('#app').classList.add('sidebar-collapsed');
    return;
  }
  loadMap(slug, { fit: true });
  if (isMobile()) $('#app').classList.add('sidebar-collapsed');
}

function resetDoc() {
  state.slug = null;
  state.doc = null;
  state.rev = 0;
  state.selectedId = null;
  state.layout = null;
  state.undo = [];
  state.redo = [];
  state.editingId = null;
  $('#editor-layer').innerHTML = '';
  hideBanner();
  renderCanvas();
  renderTopbar();
  renderInspector(true);
  renderStatusbar();
  renderMapList();
  renderOutline();
  document.title = 'mindleaf · 思维导图';
}

function showEmptyError(message) {
  resetDoc();
  $('#empty-state').hidden = false;
  $('#empty-title').textContent = '无法连接 mindleaf 服务';
  $('#empty-desc').textContent = `${message}。请确认终端里的 mindleaf serve 仍在运行，然后刷新页面。`;
}

async function deleteMap(slug) {
  const entry = state.maps.find((map) => map.slug === slug);
  const confirmed = await askConfirm({
    title: '删除导图？',
    message: `「${entry?.title ?? slug}」及其历史版本会被删除，此操作无法撤销。`,
    confirmText: '删除',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api(`/api/maps/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    const wasCurrent = slug === state.slug;
    await refreshState();
    if (wasCurrent) {
      if (state.maps.length) await loadMap(state.maps[0].slug, { fit: true });
      else resetDoc();
    }
    toast('已删除导图', { tone: 'ok' });
  } catch (error) {
    toast(error.message, { tone: 'error' });
  }
}

async function manualSave() {
  if (state.editingId) await commitEdit();
  const note = $('#insp-note');
  if (note) saveNoteNow(note.value);
  toast('编辑已自动保存，当前已是最新', { tone: 'ok', timeout: 2200 });
}

async function loadTemplates() {
  await ensureTemplates();
}

/* ==========================================================================
   事件绑定
   ========================================================================== */

function bindEvents() {
  // ---- 通用关闭按钮 / 遮罩关闭 ----
  for (const button of $$('[data-close]')) {
    button.addEventListener('click', () => closeDialog(button.closest('dialog')));
  }
  for (const dialog of $$('dialog.modal')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  // ---- 顶栏 ----
  $('#btn-sidebar').addEventListener('click', () => {
    const collapsed = $('#app').classList.toggle('sidebar-collapsed');
    if (!isMobile()) {
      try {
        localStorage.setItem('mindleaf:sidebar', collapsed ? '1' : '0');
      } catch {
        /* 忽略 */
      }
    }
  });
  $('#btn-inspector').addEventListener('click', () => {
    const collapsed = $('#app').classList.toggle('inspector-collapsed');
    if (!isMobile()) {
      try {
        localStorage.setItem('mindleaf:inspector', collapsed ? '1' : '0');
      } catch {
        /* 忽略 */
      }
    }
  });
  $('#btn-inspector-close').addEventListener('click', () => {
    $('#app').classList.add('inspector-collapsed');
  });
  $('#doc-title').addEventListener('click', openRenameDialog);
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#btn-settings').addEventListener('click', openSettingsDialog);
  $('#btn-settings-side').addEventListener('click', openSettingsDialog);
  $('#btn-export').addEventListener('click', (event) => {
    event.stopPropagation();
    if ($('#btn-export').disabled) return;
    toggleExportMenu();
  });
  $('#export-menu').addEventListener('click', (event) => {
    const item = event.target.closest('[data-export]');
    if (!item) return;
    runExport(item.dataset.export);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('.export-wrap')) closeExportMenu();
  });

  // ---- 布局 / 缩放 ----
  for (const button of $$('#layout-seg .seg-btn')) {
    button.addEventListener('click', () => setLayout(button.dataset.layout));
  }
  $('#btn-zoom-in').addEventListener('click', () => zoomCentered(1.2));
  $('#btn-zoom-out').addEventListener('click', () => zoomCentered(1 / 1.2));
  $('#zoom-value').addEventListener('click', () => {
    state.zoom = 1;
    applyTransform();
  });
  $('#btn-fit').addEventListener('click', fitView);

  // ---- 侧栏：导图 / 大纲 两个页签 ----
  $('#tab-maps').addEventListener('click', () => setSidebarTab('maps'));
  $('#tab-outline').addEventListener('click', () => setSidebarTab('outline'));

  $('#map-search').addEventListener('input', (event) => {
    state.query = event.target.value;
    renderMapList();
  });
  $('#outline-search').addEventListener('input', (event) => {
    state.outlineQuery = event.target.value;
    renderOutline();
  });

  // 标签筛选条（点在 chip 上切换）
  $('#tag-filter').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-tag]');
    if (!chip) return;
    const tag = chip.dataset.tag ?? '';
    state.tagFilter = tag && tag.toLowerCase() !== state.tagFilter.toLowerCase() ? tag : '';
    renderTagFilter();
    renderMapList();
  });

  $('#map-list').addEventListener('click', (event) => {
    const del = event.target.closest('[data-del]');
    if (del) {
      event.stopPropagation();
      deleteMap(del.dataset.del);
      return;
    }
    const tagChip = event.target.closest('.map-item-tag');
    if (tagChip) {
      event.stopPropagation();
      state.tagFilter = tagChip.dataset.tag ?? '';
      setSidebarTab('maps');
      renderTagFilter();
      renderMapList();
      return;
    }
    const tagsEdit = event.target.closest('[data-tags]');
    if (tagsEdit) {
      event.stopPropagation();
      openTagsDialog(tagsEdit.dataset.tags);
      return;
    }
    const item = event.target.closest('[data-slug]');
    if (item) selectMap(item.dataset.slug);
  });

  // 大纲：点行选中节点，点箭头折叠
  $('#outline-panel').addEventListener('click', (event) => {
    const caret = event.target.closest('[data-caret]');
    if (caret) {
      event.stopPropagation();
      const node = getNode(state.doc, caret.dataset.caret);
      if (node) runOps([{ op: 'updateNode', id: node.id, collapsed: !node.collapsed }], { label: node.collapsed ? '展开节点' : '收起节点' });
      return;
    }
    const row = event.target.closest('[data-id]');
    if (!row || !state.doc) return;
    selectNode(row.dataset.id, { reveal: true });
    if (isMobile()) $('#app').classList.add('sidebar-collapsed');
  });
  $('#outline-panel').addEventListener('keydown', (event) => {
    const row = event.target.closest('[data-id]');
    if (!row) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectNode(row.dataset.id, { reveal: true });
    }
  });

  // 标签编辑对话框
  $('#form-tags').addEventListener('submit', async (event) => {
    event.preventDefault();
    const tags = parseTagInput($('#tags-input').value);
    const button = $('#form-tags [type="submit"]');
    setFormBusy(button, true, '保存中…');
    try {
      await saveMapTags(tagsDialogSlug, tags);
      closeDialog($('#dlg-tags'));
      toast(tags.length ? `标签已改为：${tags.join('、')}` : '已清空标签', { tone: 'ok' });
    } catch (error) {
      showFormError('#tags-error', error.message);
    } finally {
      setFormBusy(button, false, '保存');
    }
  });
  $('#tag-suggest').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-suggest]');
    if (!chip) return;
    const input = $('#tags-input');
    const current = parseTagInput(input.value);
    if (!current.some((tag) => tag.toLowerCase() === chip.dataset.suggest.toLowerCase())) current.push(chip.dataset.suggest);
    input.value = current.join(', ');
    renderTagSuggestions(current);
    input.focus();
  });
  $('#map-list').addEventListener('keydown', (event) => {
    const item = event.target.closest('[data-slug]');
    if (!item) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectMap(item.dataset.slug);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteMap(item.dataset.slug);
    }
  });
  $('#btn-new-map').addEventListener('click', openNewMapDialog);
  $('#btn-import').addEventListener('click', openImportDialog);
  $('#btn-empty-new').addEventListener('click', openNewMapDialog);
  $('#btn-empty-import').addEventListener('click', openImportDialog);
  const sampleButton = $('#btn-empty-sample');
  if (sampleButton) sampleButton.addEventListener('click', createSampleMap);

  // ---- 画布 ----
  const viewport = $('#canvas-viewport');
  viewport.addEventListener('pointerdown', onCanvasPointerDown);
  viewport.addEventListener('pointermove', onCanvasPointerMove);
  viewport.addEventListener('pointerup', onCanvasPointerUp);
  viewport.addEventListener('pointercancel', onCanvasPointerUp);
  viewport.addEventListener('wheel', onCanvasWheel, { passive: false });
  viewport.addEventListener('dblclick', onCanvasDblClick);

  // ---- 检查器 ----
  const inspector = $('#inspector');
  inspector.addEventListener('click', (event) => {
    const scope = event.target.closest('[data-scope]');
    if (scope) {
      event.preventDefault();
      state.styleScope = scope.dataset.scope === 'subtree' ? 'subtree' : 'node';
      renderInspector(true);
      return;
    }
    const action = event.target.closest('[data-act]');
    if (!action) return;
    event.preventDefault();
    handleInspectorAction(action.dataset.act, action);
  });
  inspector.addEventListener('input', (event) => {
    const target = event.target;
    if (target.id === 'insp-note') scheduleNoteSave(target.value);
    else if (target.id === 'link-target') {
      state.linkDraft.target = target.value;
      updateLinkGuess();
    } else if (target.id === 'link-label') {
      state.linkDraft.label = target.value;
    }
  });
  inspector.addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset?.act === 'style-custom') {
      updateStyle(target.dataset.field, target.value);
      return;
    }
    if (target.dataset?.act === 'font-size') {
      updateTypography('fontSize', target.value);
      return;
    }
    if (target.dataset?.act === 'font-family') {
      updateTypography('font', target.value);
      return;
    }
    if (target.dataset?.act === 'box-size') {
      updateTypography(target.dataset.field, target.value);
      return;
    }
    if (target.id === 'insp-text') commitInspectorText(target.value);
    else if (target.id === 'insp-note') saveNoteNow(target.value);
    else if (target.id === 'link-kind') state.linkDraft.kind = target.value;
  });
  inspector.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!isInspectorTyping() && state.doc) renderInspector();
    }, 0);
  });
  inspector.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target.id === 'insp-text' && event.key === 'Enter') {
      event.preventDefault();
      target.blur();
    } else if (target.id === 'insp-note' && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      target.blur();
    } else if (target.id === 'link-target' && event.key === 'Enter') {
      event.preventDefault();
      addLinkFromForm();
    }
  });

  // ---- 新建向导 ----
  $('#tpl-grid').addEventListener('click', (event) => {
    const card = event.target.closest('[data-tpl]');
    if (card) selectTemplate(card.dataset.tpl);
  });
  $('#tpl-grid').addEventListener('dblclick', (event) => {
    if (event.target.closest('[data-tpl]')) goWizardStep(2);
  });
  $('#btn-map-next').addEventListener('click', () => goWizardStep(2));
  $('#btn-map-back').addEventListener('click', () => {
    state.wizard.titleTouched = $('#new-title').value.trim().length > 0;
    goWizardStep(1);
  });
  $('#new-title').addEventListener('input', () => {
    state.wizard.titleTouched = $('#new-title').value.trim().length > 0;
  });
  $('#btn-tpl-preview').addEventListener('click', toggleTemplatePreview);
  $('#form-map').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.wizard.step !== 2) {
      goWizardStep(2);
      return;
    }
    createMapFromWizard();
  });

  // ---- 导入 ----
  $('#form-import').addEventListener('submit', (event) => {
    event.preventDefault();
    submitImport();
  });
  $('#btn-import-file').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    $('#import-file-name').textContent = file.name;
    try {
      const text = await file.text();
      $('#import-markdown').value = text;
      if (!$('#import-title').value.trim()) {
        const heading = /^#\s+(.+)$/m.exec(text);
        if (heading) $('#import-title').value = heading[1].trim();
      }
    } catch {
      showFormError('#import-error', '读取文件失败');
    }
  });

  // ---- 重命名 / 设置 ----
  $('#form-rename').addEventListener('submit', (event) => {
    event.preventDefault();
    submitRename();
  });
  $('#form-settings').addEventListener('submit', (event) => {
    event.preventDefault();
    submitSettings();
  });

  // ---- 确认框 ----
  $('#confirm-ok').addEventListener('click', () => {
    const dialog = $('#dlg-confirm');
    const resolve = confirmResolve;
    confirmResolve = null;
    dialog.close();
    resolve?.(true);
  });
  $('#confirm-cancel').addEventListener('click', () => {
    const dialog = $('#dlg-confirm');
    const resolve = confirmResolve;
    confirmResolve = null;
    dialog.close();
    resolve?.(false);
  });
  $('#dlg-confirm').addEventListener('close', resetConfirm);

  // ---- PDF 提示 ----
  $('#btn-pdf-print').addEventListener('click', () => {
    closeDialog($('#dlg-pdf'));
    printDoc();
  });
  $('#btn-pdf-go').addEventListener('click', () => {
    closeDialog($('#dlg-pdf'));
    exportServer('pdf');
  });

  // ---- 外部修改提示条 ----
  $('#btn-banner-refresh').addEventListener('click', async () => {
    if (!state.slug) return;
    try {
      const data = await api(`/api/maps/${encodeURIComponent(state.slug)}`);
      applyRemoteDoc(data.doc);
    } catch (error) {
      toast(error.message, { tone: 'error' });
    }
  });
  $('#btn-banner-close').addEventListener('click', hideBanner);

  // ---- 预览抽屉 ----
  $('#btn-preview-close').addEventListener('click', closePreview);
  $('#btn-preview-reveal').addEventListener('click', revealPreview);
  $('#preview-body').addEventListener('click', (event) => {
    const item = event.target.closest('[data-path]');
    if (!item) return;
    openPreview({ kind: 'file', target: item.dataset.path, label: basename(item.dataset.path) });
  });

  // ---- 全局键盘 ----
  document.addEventListener('keydown', onGlobalKeydown);

  // ---- 窗口尺寸 / 主题 ----
  window.addEventListener('resize', () => {
    if (state.doc) applySelectionClass();
  });
  systemDark.addEventListener?.('change', () => {
    if (!state.doc) {
      applyTheme(systemTheme());
      renderCanvas();
      renderTopbar();
    }
  });
}

function onGlobalKeydown(event) {
  if (event.defaultPrevented) return;
  const meta = event.metaKey || event.ctrlKey;
  const key = String(event.key ?? '').toLowerCase();
  if (event.target.closest?.('dialog')) return;

  if (meta && key === 's') {
    event.preventDefault();
    manualSave();
    return;
  }
  if (meta && key === 'n') {
    event.preventDefault();
    openNewMapDialog();
    return;
  }
  // ⌘/Ctrl+1 看图列表，⌘/Ctrl+2 看大纲
  if (meta && (key === '1' || key === '2')) {
    event.preventDefault();
    if (key === '2' && isMobile()) $('#app').classList.remove('sidebar-collapsed');
    setSidebarTab(key === '1' ? 'maps' : 'outline');
    return;
  }
  if (meta && (key === 'z' || key === 'y')) {
    if (isTextInput(event.target)) return;
    event.preventDefault();
    if (key === 'y' || event.shiftKey) redo();
    else undo();
    return;
  }
  if (isTextInput(event.target)) return;
  if (!state.doc) return;

  switch (event.key) {
    case 'Tab':
      event.preventDefault();
      addChild();
      break;
    case 'Enter':
      event.preventDefault();
      addSibling();
      break;
    case 'Backspace':
    case 'Delete':
      event.preventDefault();
      deleteSelected();
      break;
    case 'ArrowUp':
      event.preventDefault();
      moveSelection(-1);
      break;
    case 'ArrowDown':
      event.preventDefault();
      moveSelection(1);
      break;
    case 'ArrowLeft':
      event.preventDefault();
      selectParentNode();
      break;
    case 'ArrowRight':
      event.preventDefault();
      selectFirstChildNode();
      break;
    case ' ':
    case 'Spacebar':
      event.preventDefault();
      if (state.selectedId) toggleCollapse(state.selectedId);
      break;
    case 'F2':
      event.preventDefault();
      if (state.selectedId) startEdit(state.selectedId);
      break;
    case 'Escape':
      if (!$('#preview-drawer').hidden) {
        closePreview();
      } else if (state.selectedId) {
        state.selectedId = null;
        applySelectionClass();
        renderInspector(true);
        renderStatusbar();
      }
      break;
    default:
      break;
  }
}

/* ==========================================================================
   启动
   ========================================================================== */

function initLayout() {
  let sidebarCollapsed = isMobile();
  let inspectorCollapsed = isMobile();
  try {
    if (!isMobile()) {
      sidebarCollapsed = localStorage.getItem('mindleaf:sidebar') === '1';
      inspectorCollapsed = localStorage.getItem('mindleaf:inspector') === '1';
    }
  } catch {
    /* 忽略 */
  }
  $('#app').classList.toggle('sidebar-collapsed', sidebarCollapsed);
  $('#app').classList.toggle('inspector-collapsed', inspectorCollapsed);
}

/** 从 URL 的 #slug 找到对应导图；打不开就返回 null。 */
function mapFromLocation() {
  const raw = String(location.hash ?? '').replace(/^#/, '').trim();
  if (!raw) return null;
  let slug = raw;
  try {
    slug = decodeURIComponent(raw);
  } catch {
    /* 保持原样 */
  }
  return state.maps.find((map) => map.slug === slug) ?? null;
}

async function init() {
  applyTheme(systemTheme());
  initLayout();
  bindEvents();
  setSync(false);

  try {
    await refreshState();
  } catch (error) {
    showEmptyError(error.message);
    return;
  }
  loadTemplates();

  // 打开顺序：#slug（深链接）> 上次打开的 > 列表第一张
  let target = mapFromLocation();
  if (!target) {
    try {
      const last = localStorage.getItem('mindleaf:lastSlug');
      target = state.maps.find((map) => map.slug === last) ?? state.maps[0] ?? null;
    } catch {
      target = state.maps[0] ?? null;
    }
  }
  if (target) await loadMap(target.slug, { fit: true });
  else resetDoc();

  connectEvents();

  window.addEventListener('hashchange', () => {
    const fromHash = mapFromLocation();
    if (fromHash && fromHash.slug !== state.slug) loadMap(fromHash.slug, { fit: true });
  });
}

init();
