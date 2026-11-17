/**
 * 导出编排：把文档变成 json / md / svg / html / png / jpg / pdf。
 *
 * 原则：
 *  - 能纯字符串搞定的（json/md/svg/html）永远可用；
 *  - 需要渲染的（png/jpg/pdf）走系统已有后端，并在结果里如实报告用了哪个后端；
 *  - PDF 优先"矢量文字"（Chromium），中文体制下仍可选中文字；否则退化为整页 JPEG。
 */
import fs from 'node:fs';
import path from 'node:path';
import { layoutDoc } from '../core/layout.mjs';
import { renderSvg } from '../core/svg.mjs';
import { toMarkdown } from '../core/markdown.mjs';
import { decodePng, encodeJpeg, isPng } from './image.mjs';
import { layoutToVectorPdf, jpegToPdf } from './pdf.mjs';
import { detectEngines, rasterizeSvgToPng, svgToPdfViaChromium } from './raster.mjs';

export const EXPORT_FORMATS = ['json', 'md', 'svg', 'html', 'png', 'jpg', 'pdf'];

const MAX_PDF_SIDE_PT = 1440; // 超过 20 英寸的页面在 Word/LaTeX 里很难用，按比例缩小

const hasCJK = (text) => /[^\x00-\x7f]/.test(String(text ?? ''));

function allText(doc) {
  const parts = [doc.title];
  for (const node of doc.nodes) {
    parts.push(node.text, node.note ?? '');
    for (const link of node.links ?? []) parts.push(link.label ?? '', link.target);
  }
  for (const edge of doc.edges ?? []) parts.push(edge.label ?? '');
  return parts.join('\n');
}

/** PDF 页面尺寸：保持版式比例，最长边不超过 MAX_PDF_SIDE_PT。 */
export function pdfPageSize(layout) {
  let width = layout.width * 0.75;
  let height = layout.height * 0.75;
  const longest = Math.max(width, height);
  if (longest > MAX_PDF_SIDE_PT) {
    const ratio = MAX_PDF_SIDE_PT / longest;
    width *= ratio;
    height *= ratio;
  }
  return { pageWidth: Math.round(width * 100) / 100, pageHeight: Math.round(height * 100) / 100 };
}

function hrefForNode(node, projectRoot) {
  const link = node.links.find((item) => item.kind === 'url') ?? node.links[0];
  if (!link) return null;
  if (link.kind === 'url') return link.target;
  if (/^file:\/\//i.test(link.target)) return link.target;
  if (path.isAbsolute(link.target)) return `file://${encodeURI(link.target)}`;
  if (!projectRoot) return link.target;
  return `file://${encodeURI(path.join(projectRoot, link.target))}`;
}

/** 独立 HTML：单文件、无外链，直接双击可看。 */
export function renderHtml(doc, { layout, svg, lang = 'zh' } = {}) {
  const palette = layout.palette;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${doc.title}</title>
<style>
  :root { color-scheme: ${palette.dark ? 'dark' : 'light'}; }
  html, body { margin: 0; background: ${palette.canvas}; color: ${palette.ink}; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { padding: 24px 16px 64px; }
  .wrap { max-width: 100%; overflow: auto; border: 1px solid ${palette.nodeStroke}; border-radius: 14px; background: ${palette.canvas}; }
  svg { display: block; width: 100%; height: auto; }
  footer { margin-top: 14px; font-size: 12px; color: ${palette.muted}; }
</style>
</head>
<body>
<main>
  <div class="wrap">${svg}</div>
  <footer>由 Mindleaf 导出 · ${new Date().toISOString().slice(0, 10)} · ${doc.nodes.length} 个节点</footer>
</main>
</body>
</html>
`;
}

/**
 * 导出文档。
 * @param {object} doc
 * @param {{format:string, outPath:string, scale?:number, quality?:number, theme?:string, padding?:number, transparent?:boolean, projectRoot?:string, engines?:object}} options
 */
export async function exportDoc(doc, options = {}) {
  const format = String(options.format ?? '').toLowerCase().replace(/^\./, '');
  if (!EXPORT_FORMATS.includes(format)) {
    throw new Error(`不支持的导出格式: ${options.format}（可用: ${EXPORT_FORMATS.join(', ')}）`);
  }
  const outPath = path.resolve(options.outPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const warnings = [];
  const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : format === 'png' || format === 'jpg' ? 2 : 1;
  const layout = layoutDoc(doc, { scale, theme: options.theme ?? doc.settings?.theme, padding: options.padding });
  const linkHref = (node) => hrefForNode(node, options.projectRoot);

  const writeText = (content) => {
    fs.writeFileSync(outPath, content, 'utf8');
    return { format, path: outPath, bytes: Buffer.byteLength(content), engine: 'builtin', width: layout.width, height: layout.height, warnings };
  };

  if (format === 'json') {
    return writeText(JSON.stringify(doc, null, 2) + '\n');
  }
  if (format === 'md') {
    return writeText(toMarkdown(doc));
  }
  if (format === 'svg') {
    return writeText(renderSvg(layout, { title: doc.title, linkHref, background: options.transparent !== true }));
  }
  if (format === 'html') {
    const svg = renderSvg(layout, { title: doc.title, linkHref });
    return writeText(renderHtml(doc, { layout, svg }));
  }

  const engines = options.engines ?? detectEngines();

  if (format === 'png') {
    const svg = renderSvg(layout, { title: doc.title, background: true, linkBadges: false });
    const result = await rasterizeSvgToPng(svg, { width: layout.width, height: layout.height, outPath, engines });
    if (!result.ok) throw new Error(result.error ?? 'PNG 导出失败');
    return { format, path: outPath, bytes: fs.statSync(outPath).size, engine: result.engine, width: layout.width, height: layout.height, warnings };
  }

  if (format === 'jpg') {
    const svg = renderSvg(layout, { title: doc.title, background: true, linkBadges: false });
    const pngPath = outPath + '.tmp.png';
    const result = await rasterizeSvgToPng(svg, { width: layout.width, height: layout.height, outPath: pngPath, engines });
    if (!result.ok) throw new Error(result.error ?? 'JPG 导出失败');
    try {
      const png = fs.readFileSync(pngPath);
      if (!isPng(png)) throw new Error('光栅化结果不是 PNG');
      const image = decodePng(png);
      const jpeg = encodeJpeg(image, { quality: options.quality ?? 90 });
      fs.writeFileSync(outPath, jpeg);
      return { format, path: outPath, bytes: jpeg.length, engine: `${result.engine}+mindleaf-jpeg`, width: image.width, height: image.height, warnings };
    } finally {
      try {
        fs.rmSync(pngPath, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }

  // ---- PDF ----
  const svg = renderSvg(layout, { title: doc.title, background: true, linkBadges: false });
  const { pageWidth, pageHeight } = pdfPageSize(layout);

  // 1) 矢量 PDF（Chromium）：中英文都能选中文字
  const chromiumPdf = await svgToPdfViaChromium(svg, { width: layout.width, height: layout.height, outPath, title: doc.title, engines });
  if (chromiumPdf.ok) {
    return { format, path: outPath, bytes: fs.statSync(outPath).size, engine: `${chromiumPdf.engine} (矢量文字)`, width: pageWidth, height: pageHeight, warnings };
  }

  // 2) 内置矢量 PDF：仅 ASCII，无需任何外部程序
  if (!hasCJK(allText(doc))) {
    const { buffer, skipped } = layoutToVectorPdf(layout, { title: doc.title, pageWidth, pageHeight });
    if (skipped.length) warnings.push(`内置 PDF 字体不支持 ${skipped.length} 个非 ASCII 字符`);
    fs.writeFileSync(outPath, buffer);
    return { format, path: outPath, bytes: buffer.length, engine: 'mindleaf-pdf (矢量文字)', width: pageWidth, height: pageHeight, warnings };
  }

  // 3) 整页 JPEG 的 PDF：中文能被正确显示（文字不可选）
  warnings.push('没有检测到 Chrome/Edge，PDF 里的文字用位图呈现（不可选中）。安装 Chrome/Edge 或使用网页端导出可获得矢量 PDF。');
  const pngPath = outPath + '.tmp.png';
  const raster = await rasterizeSvgToPng(svg, { width: layout.width, height: layout.height, outPath: pngPath, engines });
  if (!raster.ok) throw new Error(raster.error ?? 'PDF 导出失败：既没有 Chromium 也没有可用的 SVG 光栅化后端');
  try {
    const image = decodePng(fs.readFileSync(pngPath));
    const jpeg = encodeJpeg(image, { quality: options.quality ?? 92 });
    const { buffer } = jpegToPdf(jpeg, { width: image.width, height: image.height, pageWidth, pageHeight, title: doc.title });
    fs.writeFileSync(outPath, buffer);
    return { format, path: outPath, bytes: buffer.length, engine: `${raster.engine}+mindleaf-pdf (位图)`, width: pageWidth, height: pageHeight, warnings };
  } finally {
    try {
      fs.rmSync(pngPath, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

/** 给导出文件挑一个安全的默认文件名。 */
export function safeFileName(title, fallback = 'mindmap') {
  const base = String(title ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return base || fallback;
}
