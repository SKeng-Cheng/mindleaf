/**
 * 布局：把树算成坐标，供网页渲染器与 SVG 导出器共用。
 * 纯计算、无 DOM，因此 Node 里也能跑测试与导出。
 *
 * 算法（经典横向思维导图）：
 *   1. 量文字 -> 每个节点一个文字块（自动折行）
 *   2. 后序遍历算子树高度（叶子高度 / 子树高度取大）
 *   3. 前序遍历分配坐标：父节点垂直居中于子树，子节点依次向下堆叠
 *   4. `both` 布局把一级分支按顺序分到左右两侧，根居中
 */

import { BOX_HEIGHT_MAX, BOX_HEIGHT_MIN, BOX_WIDTH_MAX, BOX_WIDTH_MIN, FONTS, FONT_SIZE_MAX, FONT_SIZE_MIN } from './doc.mjs';

/**
 * 字体度量（单位 em，取 Chromium 实测的 system/serif/mono 三套字体栈：
 * ascent 0.941、descent 0.235）。用来把文字块真正垂直居中，
 * 而不是"拍一个 0.42 的经验值"——那样字会明显偏上。
 */
export const FONT_ASCENT = 0.941;
export const FONT_DESCENT = 0.235;

/** 一行文字里，从行顶到基线的距离（em 为单位）。 */
export function baselineOffsetEm(lineHeightEm = 1.45) {
  return (lineHeightEm - (FONT_ASCENT + FONT_DESCENT)) / 2 + FONT_ASCENT;
}

const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

export const LAYOUT_DEFAULTS = {
  fontFamily: FONT_FAMILY,
  fontSize: 15,
  level1FontSize: 17,
  rootFontSize: 21,
  lineHeight: 1.45,
  paddingX: 14,
  paddingY: 8,
  minWidth: 44,
  maxWidth: 260,
  hGap: 52,
  vGap: 12,
  rootGap: 40,
  canvasPadding: 32,
  cornerRadius: 9,
};

export const THEMES = {
  light: {
    dark: false,
    canvas: '#ffffff',
    ink: '#1f2937',
    muted: '#6b7280',
    treeLine: '#b9c5d4',
    rootFill: '#2563eb',
    rootInk: '#ffffff',
    branchFill: '#e8f0fe',
    branchInk: '#1e3a8a',
    branchStroke: '#c3d5f9',
    nodeFill: '#ffffff',
    nodeInk: '#283341',
    nodeStroke: '#d8e0ea',
    relation: '#f59e0b',
    annotation: '#2563eb',
    danger: '#dc2626',
  },
  dark: {
    dark: true,
    canvas: '#0f172a',
    ink: '#e6edf3',
    muted: '#8fa3ba',
    treeLine: '#3b5578',
    rootFill: '#3b82f6',
    rootInk: '#ffffff',
    branchFill: '#1c2f4d',
    branchInk: '#dbeafe',
    branchStroke: '#2b4670',
    nodeFill: '#141f33',
    nodeInk: '#dbe4ef',
    nodeStroke: '#2b3f5e',
    relation: '#fbbf24',
    annotation: '#60a5fa',
    danger: '#f87171',
  },
};

const isCJK = (code) =>
  code >= 0x1100 &&
  (code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd));

/** 粗略文本宽度估算（中日韩全角，其余半角）。没有 canvas 时用它足够稳定。 */
export function textWidth(text, fontSize) {
  let width = 0;
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    if (isCJK(code)) width += fontSize;
    else if (char === ' ') width += fontSize * 0.29;
    else if (/[iIl.,;:'!|]/.test(char)) width += fontSize * 0.3;
    else if (/[A-Z]/.test(char)) width += fontSize * 0.66;
    else width += fontSize * 0.54;
  }
  return width;
}

/** 按最大宽度折行。中文逐字，英文按词；超长 token 硬切。 */
export function wrapText(text, fontSize, maxWidth) {
  const value = String(text ?? '');
  if (!value) return [''];
  const tokens = value.match(/[A-Za-z0-9_\-./:@#%+=?&]+|\s+|[\s\S]/gu) ?? [...value];
  const lines = [];
  let line = '';
  let width = 0;
  const push = () => {
    lines.push(line.replace(/\s+$/, ''));
    line = '';
    width = 0;
  };
  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      if (line) {
        line += ' ';
        width += fontSize * 0.29;
      }
      continue;
    }
    const tokenWidth = textWidth(token, fontSize);
    if (width + tokenWidth > maxWidth && line) push();
    if (tokenWidth > maxWidth) {
      for (const char of token) {
        const charWidth = textWidth(char, fontSize);
        if (width + charWidth > maxWidth && line) push();
        line += char;
        width += charWidth;
      }
    } else {
      line += token;
      width += tokenWidth;
    }
  }
  if (line) push();
  return lines.length ? lines : [''];
}

function childrenMapOf(doc, collapsedIds) {
  const map = new Map();
  for (const node of doc.nodes) {
    if (node.parent == null) continue;
    if (!map.has(node.parent)) map.set(node.parent, []);
    map.get(node.parent).push(node);
  }
  for (const list of map.values()) list.sort((a, b) => a.order - b.order);
  const isCollapsed = (node) => collapsedIds.has(node.id) || node.collapsed === true;
  return { map, isCollapsed };
}

/**
 * 计算布局。
 * @param {object} doc normalize 后的文档
 * @param {{direction?:string, theme?:string, scale?:number, padding?:number, collapsedIds?:Set<string>}} options
 */
export function layoutDoc(doc, options = {}) {
  const D = LAYOUT_DEFAULTS;
  const themeName = options.theme === 'dark' || options.theme === 'light' ? options.theme : doc.settings?.theme === 'dark' ? 'dark' : 'light';
  const theme = THEMES[themeName];
  const direction = ['right', 'left', 'both'].includes(options.direction) ? options.direction : doc.settings?.layout ?? 'right';
  const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 1;
  const padding = Number.isFinite(options.padding) ? options.padding : D.canvasPadding;
  const collapsedIds = options.collapsedIds instanceof Set ? options.collapsedIds : new Set();
  const { map: children, isCollapsed } = childrenMapOf(doc, collapsedIds);
  const root = doc.nodes.find((n) => n.parent == null) ?? doc.nodes[0];

  // ---- 1. 量尺寸 ----
  const metrics = new Map();
  const measure = (node, depth) => {
    // 字号：节点自己设了就用它，否则按层级给默认值
    const baseSize = depth === 0 ? D.rootFontSize : depth === 1 ? D.level1FontSize : D.fontSize;
    const fontSize = node.fontSize
      ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, node.fontSize))
      : baseSize;
    // 框宽：节点设了就按它折行，否则按内容自适应（有上限）
    const boxWidth = node.boxWidth
      ? Math.min(BOX_WIDTH_MAX, Math.max(BOX_WIDTH_MIN, node.boxWidth))
      : null;
    const textMax = (boxWidth ? Math.max(BOX_WIDTH_MIN, boxWidth) : D.maxWidth) - D.paddingX * 2;
    const lines = wrapText(node.text, fontSize, textMax);
    const longest = Math.max(0, ...lines.map((line) => textWidth(line, fontSize)));
    let width = boxWidth ?? Math.min(D.maxWidth, Math.max(D.minWidth, Math.ceil(longest) + D.paddingX * 2));
    width = Math.min(BOX_WIDTH_MAX, Math.max(BOX_WIDTH_MIN, width));
    const textHeight = Math.ceil(lines.length * fontSize * D.lineHeight + D.paddingY * 2);
    // 框高：只放大不缩小，避免把文字压扁
    const height = node.boxHeight
      ? Math.max(textHeight, Math.min(BOX_HEIGHT_MAX, Math.max(BOX_HEIGHT_MIN, node.boxHeight)))
      : textHeight;
    const info = { fontSize, lines, width, height, fontFamily: (node.font && FONTS[node.font]?.stack) || D.fontFamily };
    metrics.set(node.id, info);
    return info;
  };

  // ---- 2. 两侧划分 ----
  const branches = children.get(root.id) ?? [];
  const sideOf = new Map();
  branches.forEach((branch, index) => {
    if (direction === 'left') sideOf.set(branch.id, 'left');
    else if (direction === 'right') sideOf.set(branch.id, 'right');
    else sideOf.set(branch.id, index % 2 === 0 ? 'right' : 'left');
  });

  // ---- 3. 子树高度（后序） ----
  const subtreeHeight = new Map();
  const measureSubtree = (node, depth) => {
    const info = measure(node, depth);
    const kids = isCollapsed(node) ? [] : children.get(node.id) ?? [];
    let total = 0;
    for (const kid of kids) total += measureSubtree(kid, depth + 1);
    if (kids.length) total += D.vGap * (kids.length - 1);
    const height = Math.max(info.height, total);
    subtreeHeight.set(node.id, height);
    return height;
  };
  measureSubtree(root, 0);
  // both 布局：左右两侧各自堆叠，根的高度取两侧较大者
  if (direction === 'both') {
    const sideHeight = (side) => {
      const list = branches.filter((branch) => sideOf.get(branch.id) === side);
      if (!list.length) return 0;
      return list.reduce((sum, branch) => sum + (subtreeHeight.get(branch.id) ?? 0), 0) + D.vGap * (list.length - 1);
    };
    const tallest = Math.max(sideHeight('right'), sideHeight('left'));
    subtreeHeight.set(root.id, Math.max(metrics.get(root.id).height, tallest));
  }

  // ---- 3.5 连线色：自己的 lineColor 优先，没设就继承父节点 ----
  const lineColorOf = new Map();
  const resolveLineColors = (node, inherited) => {
    const own = node.lineColor ?? inherited ?? null;
    lineColorOf.set(node.id, own);
    for (const kid of isCollapsed(node) ? [] : children.get(node.id) ?? []) resolveLineColors(kid, own);
  };
  resolveLineColors(root, null);
  // 折叠节点也要能查到（关联线等场景），统一补一遍
  for (const node of doc.nodes) {
    if (lineColorOf.has(node.id)) continue;
    lineColorOf.set(node.id, node.lineColor ?? null);
  }

  // ---- 4. 分配坐标（前序） ----
  const nodes = [];
  const edges = [];
  const assign = (node, depth, x, centerY, side) => {
    const info = metrics.get(node.id);
    const nodeX = side === 'left' ? x - info.width : x;
    nodes.push({
      id: node.id,
      text: node.text,
      note: node.note ?? '',
      depth,
      side,
      x: nodeX,
      y: centerY - info.height / 2,
      width: info.width,
      height: info.height,
      fontSize: info.fontSize,
      fontFamily: info.fontFamily,
      lines: info.lines,
      color: node.color ?? null,
      textColor: node.textColor ?? null,
      lineColor: lineColorOf.get(node.id) ?? null,
      links: node.links ?? [],
      hasAnnotation: Boolean(node.annotation),
      hasNote: Boolean(node.note),
      collapsed: isCollapsed(node),
      expandable: (children.get(node.id) ?? []).length > 0,
      parentId: node.parent,
    });
    const kids = isCollapsed(node) ? [] : children.get(node.id) ?? [];
    if (!kids.length) return;
    // both 布局下根节点的子节点分成左右两摞，各自以根为中心垂直排布
    const rightSide = kids.filter((kid) => (sideOf.get(kid.id) ?? side) !== 'left');
    const leftSide = kids.filter((kid) => (sideOf.get(kid.id) ?? side) === 'left');
    const stack = (list, groupSide) => {
      if (!list.length) return;
      const total = list.reduce((sum, kid) => sum + subtreeHeight.get(kid.id), 0) + D.vGap * (list.length - 1);
      let cursor = centerY - total / 2;
      for (const kid of list) {
        const kidHeight = subtreeHeight.get(kid.id);
        const kidCenterY = cursor + kidHeight / 2;
        const kidInfo = metrics.get(kid.id);
        const kidX = groupSide === 'left' ? nodeX - D.hGap : nodeX + info.width + D.hGap;
        // 注意：kidX 是子节点的“外侧边”坐标——右侧布局时是左边缘，左侧布局时是右边缘；
        // 两种情况下 assign() 都会把节点摆到正确一侧，因此终点直接用 kidX。
        edges.push({
          id: `tree:${node.id}->${kid.id}`,
          kind: 'tree',
          fromId: node.id,
          toId: kid.id,
          color: lineColorOf.get(kid.id) ?? null,
          from: { x: groupSide === 'left' ? nodeX : nodeX + info.width, y: centerY },
          to: { x: kidX, y: kidCenterY },
        });
        assign(kid, depth + 1, kidX, kidCenterY, groupSide);
        cursor += kidHeight + D.vGap;
      }
    };
    stack(rightSide, side === 'left' ? 'right' : 'right');
    stack(leftSide, 'left');
  };

  const rootInfo = metrics.get(root.id);
  if (direction === 'left') {
    // 左侧布局：根节点右边缘在原点，整棵树向左展开
    assign(root, 0, 0, 0, 'left');
  } else if (direction === 'both') {
    assign(root, 0, -rootInfo.width / 2, 0, 'right');
  } else {
    assign(root, 0, 0, 0, 'right');
  }

  // ---- 5. 关联线 ----
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of doc.edges ?? []) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    edges.push({
      id: `rel:${edge.id}`,
      kind: 'relation',
      edgeId: edge.id,
      label: edge.label ?? '',
      fromId: from.id,
      toId: to.id,
      from: { x: from.side === 'left' ? from.x : from.x + from.width, y: from.y + from.height / 2 },
      to: { x: to.side === 'left' ? to.x + to.width : to.x, y: to.y + to.height / 2 },
    });
  }

  // ---- 6. 归一化 + 缩放 ----
  const minX = Math.min(0, ...nodes.map((n) => n.x));
  const minY = Math.min(0, ...nodes.map((n) => n.y));
  const maxX = Math.max(0, ...nodes.map((n) => n.x + n.width));
  const maxY = Math.max(0, ...nodes.map((n) => n.y + n.height));
  const contentWidth = maxX - minX;
  const contentHeight = maxY - minY;
  for (const node of nodes) {
    node.x = (node.x - minX + padding) * scale;
    node.y = (node.y - minY + padding) * scale;
    node.width *= scale;
    node.height *= scale;
    node.fontSize *= scale;
    node.lineHeight = node.fontSize * D.lineHeight;
    node.paddingX = D.paddingX * scale;
    node.paddingY = D.paddingY * scale;
    node.radius = D.cornerRadius * scale;
    // 文字块整体居中：先算文字块高度，再按字体 ascent/descent 定第一行基线
    const blockHeight = node.lines.length * node.lineHeight;
    const blockTop = node.y + (node.height - blockHeight) / 2;
    node.firstBaseline = blockTop + baselineOffsetEm(D.lineHeight) * node.fontSize;
  }
  for (const edge of edges) {
    edge.from = { x: (edge.from.x - minX + padding) * scale, y: (edge.from.y - minY + padding) * scale };
    edge.to = { x: (edge.to.x - minX + padding) * scale, y: (edge.to.y - minY + padding) * scale };
  }
  // 关联线标签的位置：避开节点框，渲染时再画在节点之上（不会被遮住）
  for (const edge of edges) {
    if (edge.kind !== 'relation' || !edge.label) continue;
    edge.labelBox = relationLabelPlacement(edge, nodes, scale);
  }

  return {
    width: Math.max(1, Math.ceil((contentWidth + padding * 2) * scale)),
    height: Math.max(1, Math.ceil((contentHeight + padding * 2) * scale)),
    padding: padding * scale,
    scale,
    direction,
    theme: themeName,
    palette: theme,
    fontFamily: D.fontFamily,
    nodes,
    edges,
    rootId: root.id,
  };
}

const r2 = (value) => Math.round(value * 100) / 100;

/** 树的连线几何：水平三次贝塞尔。SVG 与 PDF 共用，保证"看到的就是导出的"。 */
export function treeGeometry(edge) {
  const { from, to } = edge;
  const reach = Math.max(18, Math.abs(to.x - from.x) * 0.5);
  const sign = to.x >= from.x ? 1 : -1;
  return {
    p0: { ...from },
    c1: { x: from.x + reach * sign, y: from.y },
    c2: { x: to.x - reach * sign, y: to.y },
    p3: { ...to },
  };
}

/** 关联线几何：向上拱起的二次贝塞尔。 */
export function relationGeometry(edge) {
  const { from, to } = edge;
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const lift = Math.max(36, Math.min(180, dy * 0.45 + dx * 0.2));
  return {
    p0: { ...from },
    cp: { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - lift },
    p2: { ...to },
  };
}

export function treePath(edge) {
  const { p0, c1, c2, p3 } = treeGeometry(edge);
  return `M ${r2(p0.x)} ${r2(p0.y)} C ${r2(c1.x)} ${r2(c1.y)}, ${r2(c2.x)} ${r2(c2.y)}, ${r2(p3.x)} ${r2(p3.y)}`;
}

export function relationPath(edge) {
  const { p0, cp, p2 } = relationGeometry(edge);
  return `M ${r2(p0.x)} ${r2(p0.y)} Q ${r2(cp.x)} ${r2(cp.y)}, ${r2(p2.x)} ${r2(p2.y)}`;
}

/** 二次贝塞尔在 t 处的点。 */
function quadPoint(p0, cp, p2, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * cp.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * cp.y + t * t * p2.y,
  };
}

/** 关联线标签中心：默认取 t=0.5（线本身的中点）。 */
export function relationLabelPoint(edge, t = 0.5) {
  const { p0, cp, p2 } = relationGeometry(edge);
  return quadPoint(p0, cp, p2, t);
}

/** 标签尺寸（字号、内边距与渲染层保持一致）。 */
export function relationLabelSize(label, scale = 1) {
  const fontSize = 12.5 * scale;
  const padding = 5 * scale;
  return {
    fontSize,
    width: Math.max(fontSize * 2, textWidth(label ?? '', fontSize) + padding * 2),
    height: fontSize * 1.66,
  };
}

function overlapArea(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * 给关联线标签挑位置：沿着曲线从 t=0.5 往两边试，选第一个不压住节点的位置。
 * 都压住时就选重叠面积最小的那个（渲染层再把标签画在节点之上，保证不会"躲在框后面"）。
 */
export function relationLabelPlacement(edge, nodes, scale = 1, gap = 2) {
  const { p0, cp, p2 } = relationGeometry(edge);
  const { fontSize, width, height } = relationLabelSize(edge.label, scale);
  const candidates = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75, 0.2, 0.8, 0.15, 0.85];
  let best = null;
  for (const t of candidates) {
    const point = quadPoint(p0, cp, p2, t);
    const box = { x: point.x - width / 2, y: point.y - height / 2, width, height };
    const hit = nodes.reduce(
      (sum, node) =>
        sum +
        overlapArea(box, {
          x: node.x - gap * scale,
          y: node.y - gap * scale,
          width: node.width + gap * scale * 2,
          height: node.height + gap * scale * 2,
        }),
      0,
    );
    if (!best || hit < best.hit) best = { t, box, hit };
    if (hit === 0) break;
  }
  return { ...best.box, fontSize, t: best?.t ?? 0.5, covered: best.hit > 0 };
}

export function palette(themeName) {
  return THEMES[themeName] ?? THEMES.light;
}
