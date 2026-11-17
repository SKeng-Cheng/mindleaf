import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDoc } from '../src/core/doc.mjs';
import { addEdge, addNode, updateNode } from '../src/core/ops.mjs';
import { layoutDoc } from '../src/core/layout.mjs';
import { exportDoc, EXPORT_FORMATS, pdfPageSize, safeFileName } from '../src/export/exporters.mjs';
import { decodePng, encodeJpeg, isPng } from '../src/export/image.mjs';
import { jpegSize, layoutToVectorPdf, jpegToPdf, hexToRgb } from '../src/export/pdf.mjs';
import { detectEngines } from '../src/export/raster.mjs';

const candidates = detectEngines();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mindleaf-export-'));
let counter = 0;
const outPath = (format) => path.join(tmpRoot, `case-${(counter += 1)}.${format}`);

function sampleDoc({ chinese = true } = {}) {
  const doc = createDoc({ title: chinese ? '导出测试' : 'Export Test', rootText: chinese ? '根节点' : 'Root' });
  const a = addNode(doc, { parent: 'root', text: chinese ? '第一章 绪论' : 'Chapter 1' });
  const b = addNode(doc, { parent: 'root', text: chinese ? '第二章 方法' : 'Chapter 2' });
  addNode(doc, { parent: a.id, text: chinese ? '研究背景' : 'Background' });
  updateNode(doc, { id: b.id, links: [{ kind: 'url', target: 'https://example.com' }] });
  addEdge(doc, { from: a.id, to: b.id, label: chinese ? '关联' : 'rel' });
  return doc;
}

test('json 导出是完整文档', async () => {
  const doc = sampleDoc();
  const file = outPath('json');
  const result = await exportDoc(doc, { format: 'json', outPath: file });
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.title, doc.title);
  assert.equal(parsed.nodes.length, doc.nodes.length);
  assert.equal(result.engine, 'builtin');
  assert.ok(result.bytes > 100);
});

test('markdown 导出包含标题层级', async () => {
  const file = outPath('md');
  const result = await exportDoc(sampleDoc(), { format: 'md', outPath: file });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# 根节点/m, 'Markdown 的一级标题对应根节点');
  assert.match(text, /^## 第一章 绪论/m);
  assert.match(text, /^### 研究背景/m);
  assert.match(text, /\[https:\/\/example\.com\]/);
  assert.ok(result.bytes > 10);
});

test('svg 导出自带 viewBox 与节点标记', async () => {
  const doc = sampleDoc();
  const file = outPath('svg');
  await exportDoc(doc, { format: 'svg', outPath: file });
  const svg = fs.readFileSync(file, 'utf8');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+" viewBox=/);
  assert.equal((svg.match(/data-node-id=/g) ?? []).length, doc.nodes.length);
  assert.match(svg, /<a href="https:\/\/example\.com"/, '带链接的节点应可点击');
});

test('html 导出是单文件且内嵌 svg', async () => {
  const file = outPath('html');
  await exportDoc(sampleDoc(), { format: 'html', outPath: file });
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<svg /);
  assert.match(html, /<\/html>\s*$/);
  assert.equal(/https?:\/\/[^"']*\.css/.test(html), false, '不应引用外部样式');
});

test('内置矢量 PDF：结构正确且中文被替换并报告', () => {
  const doc = sampleDoc({ chinese: true });
  const layout = layoutDoc(doc);
  const { pageWidth, pageHeight } = pdfPageSize(layout);
  const { buffer, skipped } = layoutToVectorPdf(layout, { title: 'T', pageWidth, pageHeight });
  const text = buffer.toString('latin1');
  assert.match(text, /^%PDF-1\.7/);
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/MediaBox \[0 0 /);
  assert.match(text, /xref/);
  assert.match(text, /%%EOF/);
  assert.ok(skipped.length > 0, '中文应被记为 skipped');
  assert.ok(pageWidth > 0 && pageHeight > 0);
});

test('内置矢量 PDF：纯英文不产生 skipped', () => {
  const doc = sampleDoc({ chinese: false });
  const layout = layoutDoc(doc);
  const { buffer, skipped } = layoutToVectorPdf(layout);
  assert.equal(skipped.length, 0);
  assert.match(buffer.toString('latin1'), /Helvetica/);
});

test('jpegToPdf 嵌入图片并给出页面尺寸', () => {
  const image = { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(200) };
  const jpeg = encodeJpeg(image, { quality: 80 });
  const { buffer, pageWidth, pageHeight } = jpegToPdf(jpeg, { width: 4, height: 4 });
  const text = buffer.toString('latin1');
  assert.match(text, /\/Subtype \/Image/);
  assert.match(text, /\/Filter \/DCTDecode/);
  assert.equal(pageWidth, 3);
  assert.equal(pageHeight, 3);
});

test('jpegSize 能解析自己编码出的尺寸', () => {
  const image = { width: 7, height: 3, data: new Uint8Array(7 * 3 * 4).fill(120) };
  const jpeg = encodeJpeg(image);
  assert.deepEqual(jpegSize(jpeg), { width: 7, height: 3 });
});

test('encodeJpeg 输出合法 marker 序列', () => {
  const image = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(90) };
  const jpeg = encodeJpeg(image, { quality: 60 });
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.equal(jpeg[jpeg.length - 2], 0xff);
  assert.equal(jpeg[jpeg.length - 1], 0xd9);
  assert.ok(jpeg.includes(Buffer.from([0xff, 0xdb])), '应有 DQT');
  assert.ok(jpeg.includes(Buffer.from([0xff, 0xc4])), '应有 DHT');
  assert.ok(jpeg.includes(Buffer.from([0xff, 0xda])), '应有 SOS');
});

test('decodePng 能解自己链路上游的 PNG', async (t) => {
  const file = outPath('png');
  const result = await exportDoc(sampleDoc({ chinese: false }), { format: 'png', outPath: file, scale: 1 });
  if (result.engine?.includes('builtin')) {
    t.skip('没有光栅化后端');
    return;
  }
  const buffer = fs.readFileSync(file);
  assert.ok(isPng(buffer));
  const image = decodePng(buffer);
  assert.ok(image.width > 100 && image.height > 50);
  assert.equal(image.data.length, image.width * image.height * 4);
  // 背景应该是浅色，文字区域应该有深色像素
  let dark = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] < 120) dark += 1;
  }
  assert.ok(dark > 50, `应有文字像素，实际 ${dark}`);
});

test('png/jpg/pdf 导出走真实后端', async (t) => {
  if (!candidates.png) {
    t.skip('本机没有 SVG 光栅化后端');
    return;
  }
  const doc = sampleDoc();
  const pngFile = outPath('png');
  const png = await exportDoc(doc, { format: 'png', outPath: pngFile, scale: 1 });
  assert.ok(fs.statSync(pngFile).size > 2000);
  assert.ok(png.engine && png.engine !== 'builtin', '应报告真实后端');

  const jpgFile = outPath('jpg');
  const jpg = await exportDoc(doc, { format: 'jpg', outPath: jpgFile, scale: 1, quality: 88 });
  assert.ok(fs.statSync(jpgFile).size > 1000);
  assert.match(jpg.engine, /mindleaf-jpeg/);
  assert.deepEqual(jpegSize(fs.readFileSync(jpgFile)), { width: png.width, height: png.height });

  const pdfFile = outPath('pdf');
  const pdf = await exportDoc(doc, { format: 'pdf', outPath: pdfFile });
  const pdfText = fs.readFileSync(pdfFile).toString('latin1');
  assert.match(pdfText, /^%PDF-/);
  assert.match(pdfText, /%%EOF/);
  assert.ok(pdf.bytes > 1000);
  if (candidates.chromium.length) {
    assert.match(pdf.engine, /矢量/, '有 Chromium 时应导出矢量 PDF');
    assert.match(pdfText, /CIDToGIDMap|FontFile2|Type0/, '中文应作为嵌入字体');
  }
});

test('JPG 与 PNG 视觉一致（借 sips 反解回 PNG 比较）', async (t) => {
  if (!candidates.png || !candidates.sips) {
    t.skip('需要光栅化后端与 sips');
    return;
  }
  const doc = sampleDoc({ chinese: false });
  const pngFile = outPath('png');
  const jpgFile = outPath('jpg');
  await exportDoc(doc, { format: 'png', outPath: pngFile, scale: 1 });
  await exportDoc(doc, { format: 'jpg', outPath: jpgFile, scale: 1, quality: 95 });
  const backFile = outPath('png');
  const { execFileSync } = await import('node:child_process');
  execFileSync(candidates.sips, ['-s', 'format', 'png', jpgFile, '--out', backFile]);
  const a = decodePng(fs.readFileSync(pngFile));
  const b = decodePng(fs.readFileSync(backFile));
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let diff = 0;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    diff += Math.abs(a.data[i] - b.data[i]);
    count += 1;
  }
  const mean = diff / count;
  assert.ok(mean < 12, `JPG 与 PNG 平均像素差应较小，实际 ${mean.toFixed(2)}`);
});

test('未知格式会报错，safeFileName 处理非法字符', async () => {
  await assert.rejects(() => exportDoc(sampleDoc(), { format: 'webp', outPath: outPath('webp') }), /不支持/);
  assert.equal(safeFileName('论文/第1章: 重点?'), '论文 第1章 重点');
  assert.equal(safeFileName(''), 'mindmap');
  assert.deepEqual(hexToRgb('#2563eb'), [37, 99, 235]);
  assert.deepEqual(hexToRgb('#fff'), [255, 255, 255]);
  assert.deepEqual(hexToRgb('bogus'), [0, 0, 0]);
  assert.equal(EXPORT_FORMATS.length, 7);
});
