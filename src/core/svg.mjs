/**
 * SVG 渲染器：把 layoutDoc 的结果画成一张完整 SVG 字符串。
 * 网页端直接 innerHTML 复用；导出 PNG/JPG/PDF 也走这里，保证"看到的就是导出的"。
 */
import { layoutDoc, relationLabelPoint, relationLabelSize, relationPath, treePath, LAYOUT_DEFAULTS } from './layout.mjs';

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
    `<marker id="${prefix}-arrow-annotation" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${palette.annotation}"/></marker>`,
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
    const stroke = edge.color || palette.relation;
    const width = 1.7 * layout.scale;
    const dash = `${num(7 * layout.scale)} ${num(5 * layout.scale)}`;
    const d = relationPath(edge);
    // 一条线三层：透明加粗的命中区（方便点击）、虚线本体、箭头
    out.push(
      `<g class="mm-edge" data-edge-id="${esc(edge.edgeId)}"${edge.hasAnnotation ? ' data-edge-annotation="1"' : ''}>`,
      `<path class="mm-edge-hit" d="${d}" fill="none" stroke="transparent" stroke-width="${num(16 * layout.scale)}" pointer-events="stroke"/>`,
      `<path class="mm-edge-line" d="${d}" fill="none" stroke="${stroke}" stroke-width="${num(width)}" stroke-dasharray="${dash}" stroke-linecap="round" opacity="0.92"/>`,
      `<path class="mm-edge-arrow" d="${d}" fill="none" stroke="none" marker-end="url(#${prefix}-${edge.hasAnnotation ? 'arrow-annotation' : 'arrow'})"/>`,
    );
    if (edge.hasAnnotation) {
      // 关联线上的批注：箭头也用蓝色，和节点的蓝点呼应
      const point = relationLabelPoint(edge);
      out.push(
        `<circle data-edge-annotation-dot="1" cx="${num(point.x)}" cy="${num(point.y - (12.5 * layout.scale) * 1.1)}" r="${num(3.4 * layout.scale)}" fill="${palette.annotation}" stroke="${palette.canvas}" stroke-width="${num(1.2 * layout.scale)}"/>`,
      );
    }
    out.push('</g>');
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
    const firstBaseline =
      node.firstBaseline ?? node.y + (node.height - node.fontSize * LAYOUT_DEFAULTS.lineHeight) / 2 + node.fontSize;
    const family = node.fontFamily ?? layout.fontFamily;
    node.lines.forEach((line, index) => {
      const y = firstBaseline + index * lineHeight;
      out.push(
        `<text x="${num(node.x + node.width / 2)}" y="${num(y)}" text-anchor="middle" font-size="${num(node.fontSize)}" font-family="${esc(family)}" font-weight="${weight}" fill="${ink}">${esc(line)}</text>`,
      );
    });
    if (node.hasAnnotation) {
      // 批注标记：左上角一个蓝色小圆点，白描边，导出的图里也有（清空批注后自动消失）
      const cx = node.x + 7 * layout.scale;
      const cy = node.y + 7 * layout.scale;
      out.push(
        `<circle data-annotation="1" cx="${num(cx)}" cy="${num(cy)}" r="${num(4.2 * layout.scale)}" fill="${palette.annotation}" stroke="${palette.canvas}" stroke-width="${num(1.6 * layout.scale)}"/>`,
      );
    }
    if (linkBadges && node.links.length) {
      const dotY = node.y + node.height / 2;
      node.links.slice(0, 3).forEach((link, index) => {
        out.push(
          `<circle cx="${num(node.x + node.width - (index * 8 + 6) * layout.scale)}" cy="${num(dotY)}" r="${num(2.6 * layout.scale)}" fill="${palette.muted}" opacity="0.55"/>`,
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

  // 关联线标签最后画：压在曲线和节点之上，不会"躲在框后面"
  for (const edge of layout.edges) {
    if (edge.kind !== 'relation' || !edge.label) continue;
    const size = relationLabelSize(edge.label, layout.scale);
    const box = edge.labelBox ?? { x: 0, y: 0, ...size };
    const stroke = edge.color || palette.relation;
    out.push(
      `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" rx="${num(box.height / 2)}" fill="${palette.canvas}" stroke="${stroke}" stroke-width="${num(layout.scale)}"/>`,
      `<text x="${num(box.x + box.width / 2)}" y="${num(box.y + box.height / 2 + size.fontSize * 0.36)}" text-anchor="middle" font-size="${num(size.fontSize)}" fill="${stroke}" font-weight="600">${esc(edge.label)}</text>`,
    );
  }
  out.push('</svg>');
  return out.join('');
}

/** 生成独立可打开的 SVG 文件（含背景）。 */
export function docToSvg(doc, options = {}) {
  const layout = layoutDoc(doc, options);
  return renderSvg(layout, { title: doc.title, ...options });
}
