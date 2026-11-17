/**
 * 文档操作（op）：所有修改都走这里，网页 UI、CLI、MCP 三条通道共用同一套语义。
 * 每个 op 都是纯函数 + 显式参数，便于测试，也让 AI 容易预测结果。
 */
import {
  ANNOTATION_MAX,
  BOX_HEIGHT_MAX,
  BOX_HEIGHT_MIN,
  BOX_WIDTH_MAX,
  BOX_WIDTH_MIN,
  DocError,
  FONT_KEYS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  cloneDoc,
  getNode,
  guessLinkKind,
  isDescendant,
  newNodeId,
  normalizeHexColor,
  normalizeTags,
  rootOf,
  subtreeIds,
} from './doc.mjs';

const need = (doc, id, field = '节点') => {
  const node = getNode(doc, id);
  if (!node) throw new DocError(`${field}不存在: ${id}`, 'not_found');
  return node;
};

const textOf = (value, fallback) => {
  if (typeof value === 'string') return value.trim() || '(空)';
  return fallback;
};

/** 插入子节点。patch.parent 缺省 = 根节点；position 缺省 = 末尾。 */
export function addNode(doc, patch = {}) {
  const parentId = patch.parent ?? rootOf(doc).id;
  const parent = need(doc, parentId, '父节点');
  if (patch.id != null) {
    if (getNode(doc, String(patch.id))) throw new DocError(`节点 id 已存在: ${patch.id}`, 'duplicate_id');
  }
  const siblings = doc.nodes.filter((n) => n.parent === parentId).sort((a, b) => a.order - b.order);
  let index = siblings.length;
  if (patch.position != null) {
    if (patch.position === 'start') index = 0;
    else if (patch.position === 'end') index = siblings.length;
    else if (Number.isInteger(patch.position) && patch.position >= 0) index = Math.min(patch.position, siblings.length);
  }
  const node = {
    id: patch.id != null ? String(patch.id) : newNodeId(doc, 'n'),
    parent: parentId,
    text: textOf(patch.text, '新节点'),
    note: typeof patch.note === 'string' ? patch.note : '',
    order: 0,
    collapsed: false,
    links: normalizeLinkPatch(patch.links),
  };
  // 新节点默认沿用「空间上的上一个节点」的颜色：插到第 i 个位置时是前一个同级节点，
  // 插到最前面（第一个子节点）时就是父节点。注意不是"跟父节点同色"。
  const previous = index > 0 ? siblings[index - 1] : parent;
  if (patch.color) node.color = patch.color;
  else if (previous?.color) node.color = previous.color;
  doc.nodes.push(node);
  siblings.splice(index, 0, node);
  siblings.forEach((sibling, i) => {
    sibling.order = i;
  });
  parent.collapsed = false;
  return node;
}

function normalizeLinkPatch(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item) return null;
      if (typeof item === 'string') {
        const target = item.trim();
        return target ? { kind: guessLinkKind(target), target } : null;
      }
      const target = String(item.target ?? '').trim();
      if (!target) return null;
      const kind = ['file', 'url', 'code'].includes(item.kind) ? item.kind : guessLinkKind(target);
      const link = { kind, target };
      if (typeof item.label === 'string' && item.label.trim()) link.label = item.label.trim();
      return link;
    })
    .filter(Boolean);
}

/** 能批量套用到整棵子树的字段：三种颜色 + 字号 + 字体。 */
const COLOR_FIELDS = ['color', 'textColor', 'lineColor'];
const TYPE_FIELDS = ['fontSize', 'font'];
const STYLE_FIELDS = [...COLOR_FIELDS, ...TYPE_FIELDS];
/** 只对单个节点生效的尺寸字段（各节点文字长度不同，不适合整枝套用）。 */
const SIZE_FIELDS = ['boxWidth', 'boxHeight'];

const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));

function setNumberField(node, key, raw, min, max) {
  const number = Number(raw);
  if (raw === '' || raw === null || !Number.isFinite(number)) {
    delete node[key];
    return;
  }
  node[key] = clamp(number, min, max);
}

function applyStyle(node, patch) {
  for (const field of COLOR_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const value = normalizeHexColor(patch[field]);
    if (value) node[field] = value;
    else delete node[field];
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'fontSize')) {
    setNumberField(node, 'fontSize', patch.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'font')) {
    const font = String(patch.font ?? '').trim();
    if (FONT_KEYS.includes(font)) node.font = font;
    else delete node.font;
  }
}

/**
 * 修改节点字段。
 * patch.subtree === true 时只允许改三种颜色，并连同所有子孙一起套用
 * （"这个分支整体换个颜色"就是靠它，一次 op 原子完成）。
 */
export function updateNode(doc, patch = {}) {
  const node = need(doc, patch.id);
  if (patch.subtree === true) {
    const handled = new Set(['id', 'op', 'type', 'subtree', ...STYLE_FIELDS]);
    const unexpected = Object.keys(patch).filter((key) => !handled.has(key));
    if (unexpected.length) {
      throw new DocError(
        `连同子节点时只能改颜色 / 字号 / 字体，不支持同时改: ${unexpected.join(', ')}`,
        'invalid_argument',
      );
    }
    if (!STYLE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(patch, field))) {
      throw new DocError('连同子节点修改时至少要给一个颜色、字号或字体', 'invalid_argument');
    }
    const ids = subtreeIds(doc, node.id);
    for (const id of ids) applyStyle(getNode(doc, id), patch);
    return node;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'text')) {
    const text = typeof patch.text === 'string' ? patch.text.trim() : '';
    node.text = text || '(空)';
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'note')) node.note = String(patch.note ?? '');
  if (Object.prototype.hasOwnProperty.call(patch, 'collapsed')) node.collapsed = patch.collapsed === true;
  // 批注：人类写给 AI 的修改要求；传空串表示"已处理完，清掉"
  if (Object.prototype.hasOwnProperty.call(patch, 'annotation')) {
    const annotation = typeof patch.annotation === 'string' ? patch.annotation.trim().slice(0, ANNOTATION_MAX) : '';
    if (annotation) node.annotation = annotation;
    else delete node.annotation;
  }
  applyStyle(node, patch);
  if (Object.prototype.hasOwnProperty.call(patch, 'boxWidth')) {
    setNumberField(node, 'boxWidth', patch.boxWidth, BOX_WIDTH_MIN, BOX_WIDTH_MAX);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'boxHeight')) {
    setNumberField(node, 'boxHeight', patch.boxHeight, BOX_HEIGHT_MIN, BOX_HEIGHT_MAX);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'links')) node.links = normalizeLinkPatch(patch.links);
  return node;
}

/** 删除节点（默认连同子树）。parentId 可指定把子节点改挂到别处再删。 */
export function removeNode(doc, patch = {}) {
  const node = need(doc, patch.id);
  const parentId = node.parent;
  if (parentId == null) throw new DocError('不能删除根节点', 'forbidden');
  const doomed = patch.reparentChildren && patch.parent != null ? [node.id] : subtreeIds(doc, node.id);
  const removeSet = new Set(doomed);
  if (patch.reparentChildren && patch.parent != null) {
    const target = need(doc, patch.parent, '新父节点');
    if (target.id === node.id) throw new DocError('不能挂到被删除节点自己身上', 'invalid_argument');
    if (removeSet.has(target.id)) throw new DocError('不能挂到被删除的子树里', 'invalid_argument');
    const list = doc.nodes.filter((n) => n.parent === node.id).sort((a, b) => a.order - b.order);
    for (const child of list) child.parent = target.id;
    const tail = doc.nodes.filter((n) => n.parent === target.id && n.id !== node.id).sort((a, b) => a.order - b.order);
    tail.forEach((child, i) => {
      child.order = i;
    });
  }
  doc.nodes = doc.nodes.filter((n) => !removeSet.has(n.id));
  doc.edges = doc.edges.filter((edge) => !removeSet.has(edge.from) && !removeSet.has(edge.to));
  const siblings = doc.nodes.filter((n) => n.parent === parentId).sort((a, b) => a.order - b.order);
  siblings.forEach((sibling, i) => {
    sibling.order = i;
  });
  return { removed: [...removeSet] };
}

/** 移动节点到新的父节点下。 */
export function moveNode(doc, patch = {}) {
  const node = need(doc, patch.id);
  const targetParentId = patch.parent;
  if (targetParentId == null) throw new DocError('缺少目标父节点 parent', 'invalid_argument');
  const target = need(doc, targetParentId, '目标父节点');
  if (target.id === node.id) throw new DocError('不能移动到自己下面', 'invalid_argument');
  if (node.parent == null) throw new DocError('不能移动根节点', 'forbidden');
  if (isDescendant(doc, node.id, target.id)) throw new DocError('不能移动到自己的子树里', 'invalid_argument');
  const oldParentId = node.parent;
  node.parent = target.id;
  target.collapsed = false;
  const oldSiblings = doc.nodes.filter((n) => n.parent === oldParentId).sort((a, b) => a.order - b.order);
  oldSiblings.forEach((sibling, i) => {
    sibling.order = i;
  });
  const newSiblings = doc.nodes.filter((n) => n.parent === target.id).sort((a, b) => a.order - b.order);
  let index = newSiblings.length;
  if (patch.position === 'start') index = 0;
  else if (Number.isInteger(patch.position) && patch.position >= 0) index = Math.min(patch.position, newSiblings.length);
  const rest = newSiblings.filter((n) => n.id !== node.id);
  rest.splice(index, 0, node);
  rest.forEach((sibling, i) => {
    sibling.order = i;
  });
  return node;
}

/** 同级上移/下移。 */
export function reorderNode(doc, patch = {}) {
  const node = need(doc, patch.id);
  if (node.parent == null) throw new DocError('根节点没有同级节点', 'forbidden');
  const siblings = doc.nodes.filter((n) => n.parent === node.parent).sort((a, b) => a.order - b.order);
  const index = siblings.findIndex((n) => n.id === node.id);
  const delta = patch.direction === 'up' || patch.delta === -1 ? -1 : 1;
  const next = index + delta;
  if (next < 0 || next >= siblings.length) return node;
  siblings.splice(index, 1);
  siblings.splice(next, 0, node);
  siblings.forEach((sibling, i) => {
    sibling.order = i;
  });
  return node;
}

/** 批量添加子节点（AI 最常用：一次展开一层）。 */
export function addChildren(doc, patch = {}) {
  const parentId = patch.parent ?? rootOf(doc).id;
  need(doc, parentId, '父节点');
  const texts = Array.isArray(patch.texts) ? patch.texts : [];
  const created = [];
  for (const text of texts) {
    created.push(addNode(doc, { parent: parentId, text: typeof text === 'string' ? text : text?.text ?? '' }));
  }
  return created;
}

export function addEdge(doc, patch = {}) {
  const from = need(doc, patch.from, '起点节点');
  const to = need(doc, patch.to, '终点节点');
  if (from.id === to.id) throw new DocError('关联线两端不能是同一个节点', 'invalid_argument');
  let id = patch.id != null ? String(patch.id) : null;
  if (id && doc.edges.some((e) => e.id === id)) throw new DocError(`关联线 id 已存在: ${id}`, 'duplicate_id');
  if (!id) {
    do {
      id = `e_${Math.random().toString(36).slice(2, 7)}`;
    } while (doc.edges.some((e) => e.id === id));
  }
  const edge = { id, from: from.id, to: to.id };
  if (typeof patch.label === 'string' && patch.label.trim()) edge.label = patch.label.trim();
  doc.edges.push(edge);
  return edge;
}

export function updateEdge(doc, patch = {}) {
  const edge = doc.edges.find((e) => e.id === patch.id);
  if (!edge) throw new DocError(`关联线不存在: ${patch.id}`, 'not_found');
  if (patch.from != null) need(doc, patch.from, '起点节点');
  if (patch.to != null) need(doc, patch.to, '终点节点');
  if (patch.from != null) edge.from = String(patch.from);
  if (patch.to != null) edge.to = String(patch.to);
  if (edge.from === edge.to) throw new DocError('关联线两端不能是同一个节点', 'invalid_argument');
  if (Object.prototype.hasOwnProperty.call(patch, 'label')) {
    if (patch.label) edge.label = String(patch.label).trim();
    else delete edge.label;
  }
  return edge;
}

export function removeEdge(doc, patch = {}) {
  const index = doc.edges.findIndex((e) => e.id === patch.id);
  if (index < 0) throw new DocError(`关联线不存在: ${patch.id}`, 'not_found');
  const [removed] = doc.edges.splice(index, 1);
  return removed;
}

/** 设置文档标题/布局/主题。 */
export function setDoc(doc, patch = {}) {
  if (typeof patch.title === 'string' && patch.title.trim()) {
    doc.title = patch.title.trim();
    const root = rootOf(doc);
    if (patch.syncRootTitle === true) root.text = doc.title;
  }
  if (patch.layout) {
    if (!['right', 'left', 'both'].includes(patch.layout)) throw new DocError(`未知布局: ${patch.layout}`, 'invalid_argument');
    doc.settings.layout = patch.layout;
  }
  if (patch.theme) {
    if (!['light', 'dark'].includes(patch.theme)) throw new DocError(`未知主题: ${patch.theme}`, 'invalid_argument');
    doc.settings.theme = patch.theme;
  }
  // 标签：传数组或 "a, b" 字符串都行；传空数组表示清空
  if (Object.prototype.hasOwnProperty.call(patch, 'tags')) doc.tags = normalizeTags(patch.tags);
  return doc;
}

/**
 * 整体应用一批 op。原子语义：先 clone，全部成功才写回。
 * ops 形如 [{op:'addNode', ...patch}]，也接受 {type:'addNode'} 别名。
 */
export function applyOps(doc, ops) {
  if (!Array.isArray(ops)) throw new DocError('ops 必须是数组', 'invalid_argument');
  const next = cloneDoc(doc);
  const results = [];
  for (const raw of ops) {
    if (!raw || typeof raw !== 'object') throw new DocError('op 必须是对象', 'invalid_argument');
    const name = raw.op ?? raw.type;
    const { op, type, ...patch } = raw;
    switch (name) {
      case 'addNode':
        results.push(addNode(next, patch));
        break;
      case 'addChildren':
        results.push(addChildren(next, patch));
        break;
      case 'updateNode':
        results.push(updateNode(next, patch));
        break;
      case 'removeNode':
        results.push(removeNode(next, patch));
        break;
      case 'moveNode':
        results.push(moveNode(next, patch));
        break;
      case 'reorderNode':
        results.push(reorderNode(next, patch));
        break;
      case 'addEdge':
        results.push(addEdge(next, patch));
        break;
      case 'updateEdge':
        results.push(updateEdge(next, patch));
        break;
      case 'removeEdge':
        results.push(removeEdge(next, patch));
        break;
      case 'setDoc':
        results.push(setDoc(next, patch));
        break;
      default:
        throw new DocError(`未知 op: ${name}`, 'unknown_op');
    }
  }
  return { doc: next, results };
}

export const OP_NAMES = [
  'addNode',
  'addChildren',
  'updateNode',
  'removeNode',
  'moveNode',
  'reorderNode',
  'addEdge',
  'updateEdge',
  'removeEdge',
  'setDoc',
];
