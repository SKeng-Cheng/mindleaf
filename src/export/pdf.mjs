/**
 * 内置 PDF 写出器（零依赖）。
 *
 * 两种模式：
 *  - vector：矩形 + 贝塞尔 + Helvetica 文字。体积小、文字可选中；只支持 ASCII
 *    （标准 14 字体没有中文字形）。适合英文导图，或在没有无头浏览器的机器上兜底。
 *  - image：把一张 JPEG 作为整页图片嵌入。中文导图在没有无头浏览器时的兜底方案，
 *    显示正确（文字不可选）。
 *
 * 坐标：内部一律用"左上原点"的布局坐标，写出时翻成 PDF 的左下原点。
 */
import { treeGeometry, relationGeometry } from '../core/layout.mjs';

const PT_PER_PX = 0.75; // CSS px(96dpi) -> pt(72dpi)

const n = (value) => {
  const rounded = Math.round(value * 1000) / 1000;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
};

const isAscii = (text) => /^[\x20-\x7e]*$/.test(String(text ?? ''));

/** PDF 字符串字面量转义（仅 ASCII）。 */
function pdfString(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function colorOps(rgb) {
  return `${n(rgb[0] / 255)} ${n(rgb[1] / 255)} ${n(rgb[2] / 255)}`;
}

/** #rrggbb / #rgb / #rrggbbaa -> [r,g,b] */
export function hexToRgb(hex) {
  let value = String(hex ?? '').trim().replace(/^#/, '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  if (value.length === 8) value = value.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(value)) return [0, 0, 0];
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function roundedRectOps(x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (radius < 0.01) return [`${n(x)} ${n(y)} ${n(w)} ${n(h)} re`];
  const k = 0.5522847498 * radius;
  return [
    `${n(x + radius)} ${n(y)} m`,
    `${n(x + w - radius)} ${n(y)} l`,
    `${n(x + w - radius + k)} ${n(y)} ${n(x + w)} ${n(y + radius - k)} ${n(x + w)} ${n(y + radius)} c`,
    `${n(x + w)} ${n(y + h - radius)} l`,
    `${n(x + w)} ${n(y + h - radius + k)} ${n(x + w - radius + k)} ${n(y + h)} ${n(x + w - radius)} ${n(y + h)} c`,
    `${n(x + radius)} ${n(y + h)} l`,
    `${n(x + radius - k)} ${n(y + h)} ${n(x)} ${n(y + h - radius + k)} ${n(x)} ${n(y + h - radius)} c`,
    `${n(x)} ${n(y + radius)} l`,
    `${n(x)} ${n(y + radius - k)} ${n(x + radius - k)} ${n(y)} ${n(x + radius)} ${n(y)} c`,
    'h',
  ];
}

/** 组装 PDF 文件：对象体 + 交叉引用表。 */
function buildPdf(objects, info = {}) {
  const chunks = [];
  const offsets = [];
  let size = 0;
  const push = (buffer) => {
    const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, 'latin1');
    chunks.push(b);
    size += b.length;
  };
  push(Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1'));
  objects.forEach((body, index) => {
    offsets[index] = size;
    push(`${index + 1} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  });
  const xrefOffset = size;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  push(xref);
  const title = info.title ? ` /Title (${pdfString(String(info.title).slice(0, 200))})` : '';
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${title} /Producer (Mindleaf) >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/** 与 layout.textWidth 一致的简化 ASCII 字宽估算。 */
function estimateWidth(text, fontSize) {
  let width = 0;
  for (const char of text) {
    if (char === ' ') width += fontSize * 0.29;
    else if (/[iIl.,;:'!|]/.test(char)) width += fontSize * 0.3;
    else if (/[A-Z]/.test(char)) width += fontSize * 0.66;
    else width += fontSize * 0.54;
  }
  return width;
}

function nodeColors(node, palette) {
  const ink = node.textColor || (node.color ? '#131a24' : null);
  if (node.color) return { fill: node.color, ink: ink || '#131a24', stroke: '#000000', stroked: false };
  if (node.depth === 0) return { fill: palette.rootFill, ink: ink || palette.rootInk, stroked: false };
  if (node.depth === 1) return { fill: palette.branchFill, ink: ink || palette.branchInk, stroke: palette.branchStroke, stroked: true };
  return { fill: palette.nodeFill, ink: ink || palette.nodeInk, stroke: palette.nodeStroke, stroked: true };
}

/**
 * 矢量 PDF。
 * @param {object} layout layoutDoc 的结果
 * @param {{title?:string, pageWidth?:number, pageHeight?:number}} options
 */
export function layoutToVectorPdf(layout, options = {}) {
  const palette = layout.palette;
  const pageWidth = options.pageWidth ?? Math.round(layout.width * PT_PER_PX * 100) / 100;
  const pageHeight = options.pageHeight ?? Math.round(layout.height * PT_PER_PX * 100) / 100;
  const scale = Math.min(pageWidth / layout.width, pageHeight / layout.height);
  const pxs = (value) => value * scale;
  const fy = (y) => pageHeight - y * scale; // 左上 y -> PDF y

  const ops = [];
  const skipped = [];

  const textOp = (text, centerX, baselineTopY, fontSize, rgb, bold) => {
    const safe = Array.from(String(text ?? ''))
      .map((char) => {
        if (isAscii(char)) return char;
        skipped.push(char);
        return '?';
      })
      .join('');
    if (!safe.trim()) return;
    const width = estimateWidth(safe, fontSize) * 0.98;
    ops.push(
      'q',
      `${colorOps(rgb)} rg`,
      'BT',
      `${bold ? '/F2' : '/F1'} ${n(fontSize)} Tf`,
      `${n(centerX - width / 2)} ${n(fy(baselineTopY))} Td`,
      `(${pdfString(safe)}) Tj`,
      'ET',
      'Q',
    );
  };

  // 背景
  ops.push(`${colorOps(hexToRgb(palette.canvas))} rg`, `0 0 ${n(pageWidth)} ${n(pageHeight)} re`, 'f');

  // 树连线
  ops.push('q', `${n(Math.max(1.1, 1.6 * scale))} w`, '1 J', '1 j', `${colorOps(hexToRgb(palette.treeLine))} RG`);
  for (const edge of layout.edges) {
    if (edge.kind !== 'tree') continue;
    const { p0, c1, c2, p3 } = treeGeometry(edge);
    // 每条线单独设色：设了 lineColor 就用自己的，否则用主题色
    if (edge.color) ops.push('q', `${colorOps(hexToRgb(edge.color))} RG`);
    ops.push(
      `${n(pxs(p0.x))} ${n(fy(p0.y))} m`,
      `${n(pxs(c1.x))} ${n(fy(c1.y))} ${n(pxs(c2.x))} ${n(fy(c2.y))} ${n(pxs(p3.x))} ${n(fy(p3.y))} c`,
      'S',
    );
    if (edge.color) ops.push('Q');
  }
  ops.push('Q');

  // 关联线 + 箭头 + 标签
  const relColor = hexToRgb(palette.relation);
  for (const edge of layout.edges) {
    if (edge.kind !== 'relation') continue;
    const { p0, cp, p2 } = relationGeometry(edge);
    ops.push(
      'q',
      `${n(1.3 * scale)} w`,
      `${colorOps(relColor)} RG`,
      `[${n(5 * scale)} ${n(3.6 * scale)}] 0 d`,
      `${n(pxs(p0.x))} ${n(fy(p0.y))} m`,
      `${n(pxs(cp.x))} ${n(fy(cp.y))} ${n(pxs(p2.x))} ${n(fy(p2.y))} ${n(pxs(p2.x))} ${n(fy(p2.y))} c`,
      'S',
      'Q',
    );
    // 箭头：终点处沿切线方向
    const angle = Math.atan2(p2.y - cp.y, p2.x - cp.x);
    const len = 8 * scale;
    const back = { x: p2.x - Math.cos(angle) * len, y: p2.y - Math.sin(angle) * len };
    const perp = { x: -Math.sin(angle) * len * 0.4, y: Math.cos(angle) * len * 0.4 };
    ops.push(
      `${colorOps(relColor)} rg`,
      `${n(pxs(p2.x))} ${n(fy(p2.y))} m`,
      `${n(pxs(back.x + perp.x))} ${n(fy(back.y + perp.y))} l`,
      `${n(pxs(back.x - perp.x))} ${n(fy(back.y - perp.y))} l`,
      'f',
    );
    if (edge.label) {
      const labelTop = Math.min(p0.y, p2.y) - Math.abs(Math.min(p0.y, p2.y) - cp.y) * 0.62;
      textOp(edge.label, (p0.x + p2.x) / 2, labelTop, 10.5 * scale, relColor, true);
    }
  }

  // 节点
  for (const node of layout.nodes) {
    const colors = nodeColors(node, palette);
    const fill = hexToRgb(colors.fill);
    const ink = hexToRgb(colors.ink);
    const x = pxs(node.x);
    const w = pxs(node.width);
    const h = pxs(node.height);
    const boxY = fy(node.y) - h;
    const radius = pxs(node.radius ?? 9);
    ops.push(`${colorOps(fill)} rg`);
    if (colors.stroked) ops.push(`${n(Math.max(0.6, scale))} w`, `${colorOps(hexToRgb(colors.stroke))} RG`);
    ops.push(...roundedRectOps(x, boxY, w, h, radius), colors.stroked ? 'B' : 'f');
    const fontSize = pxs(node.fontSize);
    const lineHeight = pxs(node.lineHeight ?? node.fontSize * 1.45);
    const blockHeight = node.lines.length * lineHeight;
    const firstBaseline = node.y + (node.height - blockHeight) / 2 + node.fontSize * 0.36 + (node.lineHeight - node.fontSize) / 2;
    node.lines.forEach((line, index) => {
      textOp(line, node.x + node.width / 2, firstBaseline + index * (node.lineHeight ?? node.fontSize * 1.45), fontSize, ink, node.depth <= 1);
    });
  }

  const content = ops.join('\n');
  const contentBuffer = Buffer.from(content, 'latin1');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pageWidth)} ${n(pageHeight)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    Buffer.concat([Buffer.from(`<< /Length ${contentBuffer.length} >>\nstream\n`, 'latin1'), contentBuffer, Buffer.from('\nendstream', 'latin1')]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  return { buffer: buildPdf(objects, { title: options.title }), skipped, pageWidth, pageHeight, mode: 'vector' };
}

/** 解析 JPEG 的宽高（SOF0/SOF2…）。 */
export function jpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      offset += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * 图片 PDF：整页一张 JPEG（DCTDecode 直接嵌入，不重新编码）。
 * @param {Buffer} jpeg
 * @param {{width?:number, height?:number, pageWidth?:number, pageHeight?:number, title?:string}} options
 */
export function jpegToPdf(jpeg, options = {}) {
  const size = jpegSize(jpeg);
  const imgWidth = options.width ?? size?.width ?? 800;
  const imgHeight = options.height ?? size?.height ?? 600;
  const pageWidth = options.pageWidth ?? Math.round(imgWidth * PT_PER_PX * 100) / 100;
  const pageHeight = options.pageHeight ?? Math.round(imgHeight * PT_PER_PX * 100) / 100;
  const content = `q\n${n(pageWidth)} 0 0 ${n(pageHeight)} 0 0 cm\n/Im1 Do\nQ`;
  const contentBuffer = Buffer.from(content, 'latin1');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pageWidth)} ${n(pageHeight)}] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>`,
    Buffer.concat([Buffer.from(`<< /Length ${contentBuffer.length} >>\nstream\n`, 'latin1'), contentBuffer, Buffer.from('\nendstream', 'latin1')]),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${imgWidth} /Height ${imgHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        'latin1',
      ),
      jpeg,
      Buffer.from('\nendstream', 'latin1'),
    ]),
  ];
  return { buffer: buildPdf(objects, { title: options.title }), pageWidth, pageHeight, mode: 'image' };
}

export { PT_PER_PX };
