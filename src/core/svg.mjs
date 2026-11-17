/**
 * SVG 渲染器：把 layoutDoc 的结果画成一张完整 SVG 字符串。
 * 网页端直接 innerHTML 复用；导出 PNG/JPG/PDF 也走这里，保证"看到的就是导出的"。
 */
import { layoutDoc, relationLabelPoint, relationPath, treePath, LAYOUT_DEFAULTS } from './layout.mjs';

export const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const num = (value) => Math.round(value * 100) / 100;

function nodeFill(node, palette) {
  if (node.color) return node.color;
  if (node.depth === 0) return palette.rootFill;
  if (node.depth === 1) return palette.branchFill;
  return palette.nodeFill;
}

function nodeInk(node, palette) {
  // 自定义字体色优先；否则根据层级/底色挑一个能看清的颜色
  if (node.textColor) return node.textColor;
  if (node.color) return '#131a24';
  if (node.depth === 0) return palette.rootInk;
  if (node.depth === 1) return palette.branchInk;
  return palette.nodeInk;
}

function nodeStroke(node, palette) {
  if (node.color) return 'rgba(0,0,0,0.14)';
  if (node.depth === 0) return 'transparent';
  if (node.depth === 1) return palette.branchStroke;
  return palette.nodeStroke;
}

/**
 * 渲染 SVG。
 * @param {object} layout layoutDoc 的返回值
 * @param {{background?:boolean, idPrefix?:string, linkBadges?:boolean, title?:string, linkHref?: (node:object)=>string|null}} options
 *   linkHref：给出则把带链接的节点包进 `<a>`，导出的 SVG/HTML 里点节点即可跳转。
 */
export function renderSvg(layout, options = {}) {
  const palette = layout.palette;
  const prefix = options.idPrefix ?? 'ml';
  const withBackground = options.background !== false;
  const linkBadges = options.linkBadges !== false;
  const linkHref = typeof options.linkHref === 'function' ? options.linkHref : null;
  const width = layout.width;
  const height = layout.height;
  const out = [];
  const defs = [];

  defs.push(
    `<marker id="${prefix}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${palette.relation}"/></marker>`,
  );

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(layout.fontFamily)}" role="img" aria-label="${esc(options.title ?? '思维导图')}">`,
  );
  out.push(`<defs>${defs.join('')}</defs>`);
  if (withBackground) out.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${palette.canvas}"/>`);

  // 连线先画，节点压在上层
  for (const edge of layout.edges) {
    if (edge.kind === 'tree') {
      const stroke = edge.color || palette.treeLine;
      out.push(
        `<path d="${treePath(edge)}" fill="none" stroke="${stroke}" stroke-width="${num(Math.max(1.4, 2.1 * layout.scale))}" stroke-linecap="round"/>`,
      );
    }
  }
  for (const edge of layout.edges) {
    if (edge.kind !== 'relation') continue;
    out.push(
      `<path d="${relationPath(edge)}" fill="none" stroke="${palette.relation}" stroke-width="${num(1.7 * layout.scale)}" stroke-dasharray="${num(7 * layout.scale)} ${num(5 * layout.scale)}" stroke-linecap="round" marker-end="url(#${prefix}-arrow)" opacity="0.92"/>`,
    );
    if (edge.label) {
      const point = relationLabelPoint(edge);
      const padding = 5 * layout.scale;
      const fontSize = 12.5 * layout.scale;
      const w = Math.max(1, [...edge.label].length) * fontSize * 0.72 + padding * 2;
      out.push(
        `<rect x="${num(point.x - w / 2)}" y="${num(point.y - fontSize * 0.95 - padding / 2)}" width="${num(w)}" height="${num(fontSize * 1.55)}" rx="${num(fontSize * 0.6)}" fill="${palette.canvas}" stroke="${palette.relation}" stroke-width="${num(layout.scale)}" opacity="0.97"/>`,
        `<text x="${num(point.x)}" y="${num(point.y)}" text-anchor="middle" font-size="${num(fontSize)}" fill="${palette.relation}" font-weight="600">${esc(edge.label)}</text>`,
      );
    }
  }

  for (const node of layout.nodes) {
    const fill = nodeFill(node, palette);
    const ink = nodeInk(node, palette);
    const stroke = nodeStroke(node, palette);
    const weight = node.depth === 0 ? 700 : node.depth === 1 ? 600 : 500;
    const href = linkHref && node.links.length ? linkHref(node) : null;
    const title = node.links.map((link) => link.label || link.target).join('\n');
    out.push(href ? `<a href="${esc(href)}" target="_blank" rel="noopener">` : '', href && title ? `<title>${esc(title)}</title>` : '');
    out.push(
      `<g data-node-id="${esc(node.id)}">`,
      `<rect x="${num(node.x)}" y="${num(node.y)}" width="${num(node.width)}" height="${num(node.height)}" rx="${num(node.radius)}" ry="${num(node.radius)}" fill="${fill}" stroke="${stroke}" stroke-width="${num(Math.max(1, layout.scale))}"/>`,
    );
    const lineHeight = node.lineHeight ?? node.fontSize * LAYOUT_DEFAULTS.lineHeight;
    const textBlock = node.lines.length * lineHeight;
    const firstBaseline = node.y + (node.height - textBlock) / 2 + node.fontSize * 0.42 + (lineHeight - node.fontSize) / 2;
    const family = node.fontFamily ?? layout.fontFamily;
    node.lines.forEach((line, index) => {
      const y = firstBaseline + index * lineHeight;
      out.push(
        `<text x="${num(node.x + node.width / 2)}" y="${num(y)}" text-anchor="middle" font-size="${num(node.fontSize)}" font-family="${esc(family)}" font-weight="${weight}" fill="${ink}">${esc(line)}</text>`,
      );
    });
    if (linkBadges && node.links.length) {
      const dotY = node.y + node.height / 2;
      node.links.slice(0, 3).forEach((link, index) => {
        out.push(
          `<circle cx="${num(node.x + node.width - (index * 8 + 6) * layout.scale)}" cy="${num(dotY)}" r="${num(2.6 * layout.scale)}" fill="${palette.relation}" opacity="0.95"/>`,
        );
      });
    }
    if (node.expandable) {
      const cx = node.side === 'left' ? node.x - 9 * layout.scale : node.x + node.width + 9 * layout.scale;
      const cy = node.y + node.height / 2;
      out.push(
        `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(7 * layout.scale)}" fill="${palette.canvas}" stroke="${palette.treeLine}" stroke-width="${num(layout.scale)}"/>`,
        `<text x="${num(cx)}" y="${num(cy + 3.4 * layout.scale)}" text-anchor="middle" font-size="${num(10 * layout.scale)}" fill="${palette.muted}" font-weight="700">${node.collapsed ? '+' : '−'}</text>`,
      );
    }
    out.push('</g>');
    if (href) out.push('</a>');
  }

  out.push('</svg>');
  return out.join('');
}

/** 生成独立可打开的 SVG 文件（含背景）。 */
export function docToSvg(doc, options = {}) {
  const layout = layoutDoc(doc, options);
  return renderSvg(layout, { title: doc.title, ...options });
}
