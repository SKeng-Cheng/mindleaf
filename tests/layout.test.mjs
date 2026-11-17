import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createDoc } from '../src/core/doc.mjs';
import { addEdge, addNode, updateNode } from '../src/core/ops.mjs';
import { layoutDoc, textWidth, wrapText, treePath, relationPath, relationGeometry, relationLabelPoint, relationLabelPlacement, THEMES } from '../src/core/layout.mjs';
import { renderSvg, docToSvg, esc } from '../src/core/svg.mjs';

/** 近似相等（node:assert 没有 approximately） */
const close = (actual, expected, tolerance = 0.51) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} 与 ${expected} 相差超过 ${tolerance}`);

function sampleDoc() {
  const doc = createDoc({ title: '布局测试', rootText: '根节点' });
  const chapters = ['第一章 绪论', '第二章 相关工作与理论基础', '第三章 方法', '第四章 实验与分析', '第五章 总结'];
  for (const text of chapters) {
    const chapter = addNode(doc, { parent: 'root', text });
    addNode(doc, { parent: chapter.id, text: `${text} 的第一小节` });
    addNode(doc, { parent: chapter.id, text: `${text} 的第二小节，文字稍微长一点以测试折行` });
  }
  return doc;
}

test('textWidth 中文字宽接近字号，英文更窄', () => {
  assert.ok(Math.abs(textWidth('中文', 10) - 20) < 0.01);
  assert.ok(textWidth('abc', 10) < textWidth('中文', 10));
  assert.equal(textWidth('', 10), 0);
});

test('wrapText 按最大宽度折行且不丢字', () => {
  const text = '基于多模态大模型的弱监督视觉语言对齐方法研究';
  const lines = wrapText(text, 15, 120);
  assert.ok(lines.length > 1);
  assert.equal(lines.join('').replace(/\s/g, ''), text);
  for (const line of lines) assert.ok(textWidth(line, 15) <= 120 + 15, `行超宽: ${line}`);
});

test('wrapText 处理超长英文 token 与空文本', () => {
  const lines = wrapText('a'.repeat(200), 12, 100);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(''), 'a'.repeat(200));
  assert.deepEqual(wrapText('', 12, 100), ['']);
  assert.deepEqual(wrapText(null, 12, 100), ['']);
});

test('layoutDoc 生成所有节点且不重叠', () => {
  const doc = sampleDoc();
  const layout = layoutDoc(doc);
  assert.equal(layout.nodes.length, doc.nodes.length);
  assert.equal(layout.edges.filter((edge) => edge.kind === 'tree').length, doc.nodes.length - 1);
  for (const node of layout.nodes) {
    assert.ok(node.width > 0 && node.height > 0);
    assert.ok(node.x >= 0 && node.y >= 0, '节点应在画布内');
    assert.ok(node.x + node.width <= layout.width + 0.5, '节点不应超出右边界');
    assert.ok(node.y + node.height <= layout.height + 0.5, '节点不应超出下边界');
  }
  // 节点矩形两两不重叠
  for (let i = 0; i < layout.nodes.length; i += 1) {
    for (let j = i + 1; j < layout.nodes.length; j += 1) {
      const a = layout.nodes[i];
      const b = layout.nodes[j];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(overlapX <= 0 || overlapY <= 0, `节点重叠: ${a.text} / ${b.text}`);
    }
  }
});

/** 断言一条树连线的两端都贴在父/子节点矩形边缘中点（三种布局都适用）。 */
function assertTreeEdgesAttach(layout) {
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const onEdge = (point, box) =>
    Math.abs(point.y - (box.y + box.height / 2)) <= 0.51 &&
    (Math.abs(point.x - box.x) <= 0.51 || Math.abs(point.x - (box.x + box.width)) <= 0.51);
  for (const edge of layout.edges) {
    if (edge.kind !== 'tree') continue;
    const parent = byId.get(edge.fromId);
    const child = byId.get(edge.toId);
    assert.ok(parent && child, `连线 ${edge.id} 指向不存在的节点`);
    assert.ok(onEdge(edge.from, parent), `连线起点不在父节点边缘: ${edge.id} ${JSON.stringify(edge.from)} / ${JSON.stringify(parent)}`);
    assert.ok(onEdge(edge.to, child), `连线终点不在子节点边缘: ${edge.id} ${JSON.stringify(edge.to)} / ${JSON.stringify(child)}`);
    // 两端必须在画布范围内（历史 bug：左侧布局的终点会飘到画布另一侧）
    for (const point of [edge.from, edge.to]) {
      assert.ok(point.x >= -1 && point.x <= layout.width + 1, `连线端点横向越界: ${edge.id} x=${point.x}`);
      assert.ok(point.y >= -1 && point.y <= layout.height + 1, `连线端点纵向越界: ${edge.id} y=${point.y}`);
    }
  }
}

test('layoutDoc 树连线端点贴合父/子节点边缘（三种布局）', () => {
  const doc = sampleDoc();
  for (const direction of ['right', 'left', 'both']) {
    const layout = layoutDoc(doc, { direction });
    assertTreeEdgesAttach(layout);
  }
});

test('layoutDoc 左侧布局是右侧布局的镜像（尺寸一致、x 关于中线对称）', () => {
  const doc = sampleDoc();
  const right = layoutDoc(doc, { direction: 'right' });
  const left = layoutDoc(doc, { direction: 'left' });
  assert.ok(Math.abs(right.width - left.width) <= 2, `宽度应一致: ${right.width} vs ${left.width}`);
  assert.ok(Math.abs(right.height - left.height) <= 2, `高度应一致: ${right.height} vs ${left.height}`);
  const rightRoot = right.nodes.find((node) => node.id === 'root');
  const leftRoot = left.nodes.find((node) => node.id === 'root');
  assert.ok(leftRoot.x + leftRoot.width / 2 > rightRoot.x + rightRoot.width / 2, '左侧布局的根应更靠右');
  assertTreeEdgesAttach(left);
});

test('layoutDoc both 布局把一级分支分到两侧', () => {
  const doc = sampleDoc();
  const layout = layoutDoc(doc, { direction: 'both' });
  const root = layout.nodes.find((node) => node.id === 'root');
  const firstLevel = layout.nodes.filter((node) => node.depth === 1);
  const left = firstLevel.filter((node) => node.x < root.x);
  const right = firstLevel.filter((node) => node.x > root.x);
  assert.ok(left.length >= 2, '左侧应有分支');
  assert.ok(right.length >= 2, '右侧应有分支');
  const leftKids = layout.nodes.filter((node) => node.depth === 2 && node.side === 'left');
  for (const kid of leftKids) assert.ok(kid.x < root.x, '左侧分支的子节点应在根左边');
});

test('layoutDoc left 布局全部在左侧', () => {
  const doc = sampleDoc();
  const layout = layoutDoc(doc, { direction: 'left' });
  const root = layout.nodes.find((node) => node.id === 'root');
  for (const node of layout.nodes) {
    if (node.id === 'root') continue;
    assert.ok(node.x < root.x, `${node.text} 应在根左侧`);
  }
});

test('layoutDoc 折叠后隐藏子树', () => {
  const doc = sampleDoc();
  const full = layoutDoc(doc);
  const chapter = doc.nodes.find((node) => node.text.startsWith('第三章'));
  updateNode(doc, { id: chapter.id, collapsed: true });
  const collapsed = layoutDoc(doc);
  assert.ok(collapsed.nodes.length < full.nodes.length);
  assert.ok(collapsed.height < full.height);
  const chapterNode = collapsed.nodes.find((node) => node.id === chapter.id);
  assert.equal(chapterNode.collapsed, true);
  assert.equal(chapterNode.expandable, true);
});

test('layoutDoc 支持 scale 与暗色主题', () => {
  const doc = sampleDoc();
  const normal = layoutDoc(doc, { scale: 1 });
  const doubled = layoutDoc(doc, { scale: 2 });
  assert.ok(Math.abs(doubled.width - normal.width * 2) <= 3, `宽应约等于 2 倍: ${doubled.width} vs ${normal.width}`);
  assert.ok(Math.abs(doubled.height - normal.height * 2) <= 3, `高应约等于 2 倍: ${doubled.height} vs ${normal.height}`);
  assert.equal(doubled.padding, normal.padding * 2);
  const dark = layoutDoc(doc, { theme: 'dark' });
  assert.equal(dark.theme, 'dark');
  assert.equal(dark.palette.canvas, THEMES.dark.canvas);
});

test('layoutDoc 把连线色传给边，并且子节点继承父节点', () => {
  const doc = createDoc({ title: 'c', rootText: '根' });
  const branch = addNode(doc, { parent: 'root', text: '分支' });
  const child = addNode(doc, { parent: branch.id, text: '子' });
  const other = addNode(doc, { parent: 'root', text: '别的分支' });
  updateNode(doc, { id: branch.id, lineColor: '#0EA5E9', textColor: '#b91c1c' });

  const layout = layoutDoc(doc);
  const edgeTo = (id) => layout.edges.find((edge) => edge.kind === 'tree' && edge.toId === id);
  assert.equal(edgeTo(branch.id).color, '#0ea5e9');
  assert.equal(edgeTo(child.id).color, '#0ea5e9', '没自己设颜色时继承父节点');
  assert.equal(edgeTo(other.id).color, null, '别的分支不受影响');

  const node = (id) => layout.nodes.find((item) => item.id === id);
  assert.equal(node(branch.id).textColor, '#b91c1c');
  assert.equal(node(branch.id).lineColor, '#0ea5e9');
  assert.equal(node(child.id).lineColor, '#0ea5e9');
});

test('layoutDoc 尊重节点字号、字体和框宽高', () => {
  const doc = createDoc({ title: '排版', rootText: '根' });
  const node = addNode(doc, { parent: 'root', text: '一段比较长的节点文字用来测试换行行为' });
  const before = layoutDoc(doc).nodes.find((item) => item.id === node.id);

  updateNode(doc, { id: node.id, fontSize: 24, font: 'kai', boxWidth: 120, boxHeight: 120 });
  const after = layoutDoc(doc).nodes.find((item) => item.id === node.id);

  assert.equal(after.fontSize, 24, '字号生效');
  assert.match(after.fontFamily, /Kaiti|KaiTi/, '字体栈生效');
  assert.equal(after.width, 120, '框宽固定');
  assert.ok(after.height >= 120, '框高不低于设定值');
  assert.ok(after.lines.length >= before.lines.length, '窄框会折更多行');
});

test('layoutDoc 框高不会小于文字所需高度', () => {
  const doc = createDoc({ title: '高度', rootText: '根' });
  const node = addNode(doc, { parent: 'root', text: '很长很长的一段文字' });
  updateNode(doc, { id: node.id, fontSize: 20, boxWidth: 80, boxHeight: 24 });
  const laid = layoutDoc(doc).nodes.find((item) => item.id === node.id);
  assert.ok(laid.height > 24, '文字撑开后高度应大于设定的最小值');
});

test('layoutDoc 关联线出现在 edges 里', () => {
  const doc = sampleDoc();
  const a = doc.nodes[1];
  const b = doc.nodes[3];
  addEdge(doc, { from: a.id, to: b.id, label: '交叉引用' });
  const layout = layoutDoc(doc);
  const relation = layout.edges.find((edge) => edge.kind === 'relation');
  assert.ok(relation);
  assert.equal(relation.label, '交叉引用');
  assert.match(relationPath(relation), /^M .* Q /);
  const geometry = relationGeometry(relation);
  assert.ok(geometry.cp.y <= Math.min(geometry.p0.y, geometry.p2.y), '关联线应向上拱起');
});

test('关联线标签默认落在曲线中点（t=0.5），而不是飘在线的上方', () => {
  const doc = sampleDoc();
  const a = doc.nodes[1];
  const b = doc.nodes[3];
  addEdge(doc, { from: a.id, to: b.id, label: '影响' });
  const relation = layoutDoc(doc).edges.find((edge) => edge.kind === 'relation');
  const { p0, cp, p2 } = relationGeometry(relation);
  const point = relationLabelPoint(relation);

  // 二次贝塞尔 t=0.5 的解析解
  const onCurve = { x: (p0.x + 2 * cp.x + p2.x) / 4, y: (p0.y + 2 * cp.y + p2.y) / 4 };
  close(point.x, onCurve.x, 0.01);
  close(point.y, onCurve.y, 0.01);

  // 反例：以前那种"在线上面"的位置，y 明显更小（更高）
  const floatingY = Math.min(p0.y, p2.y) - Math.abs(Math.min(p0.y, p2.y) - cp.y) * 0.62;
  assert.ok(point.y > floatingY + 1, `标签应压在线上（${point.y}）而不是浮在上方（${floatingY}）`);
});

test('标签位置会让开节点框：正中点被节点占住时沿曲线挪开', () => {
  // 造一条竖直方向的关联线，然后在它的中点位置放一个"节点"
  const edge = { from: { x: 100, y: 300 }, to: { x: 300, y: 300 }, label: '影响' };
  const { cp } = relationGeometry(edge);
  const mid = relationLabelPoint(edge);
  const blocker = { x: mid.x - 25, y: mid.y - 15, width: 50, height: 30 };

  const placement = relationLabelPlacement(edge, [blocker], 1);
  assert.ok(placement.t !== 0.5, '中点被占时应该挪开');
  assert.equal(placement.covered, false, '应该能找到不被压住的位置');
  const overlaps =
    placement.x < blocker.x + blocker.width &&
    placement.x + placement.width > blocker.x &&
    placement.y < blocker.y + blocker.height &&
    placement.y + placement.height > blocker.y;
  assert.equal(overlaps, false, '挪开之后不应再和节点框重叠');
  // 挪开的位置仍然在曲线上
  const onCurve = relationLabelPoint(edge, placement.t);
  close(placement.x + placement.width / 2, onCurve.x, 0.01);
  close(placement.y + placement.height / 2, onCurve.y, 0.01);
  void cp;
});

test('示例图里所有关联线标签都不压住节点', () => {
  const doc = JSON.parse(readFileSync(new URL('../examples/demo.mindmap.json', import.meta.url), 'utf8'));
  const layout = layoutDoc(doc);
  const labels = layout.edges.filter((edge) => edge.kind === 'relation' && edge.label);
  assert.ok(labels.length > 0, '示例图里应有带标签的关联线');
  for (const edge of labels) {
    const box = edge.labelBox;
    assert.ok(box, `${edge.label} 应该有 labelBox`);
    for (const node of layout.nodes) {
      const width = Math.min(box.x + box.width, node.x + node.width) - Math.max(box.x, node.x);
      const height = Math.min(box.y + box.height, node.y + node.height) - Math.max(box.y, node.y);
      assert.ok(
        !(width > 0 && height > 0),
        `标签「${edge.label}」压住了节点「${node.text}」：重叠 ${width.toFixed(1)}×${height.toFixed(1)}`,
      );
    }
  }
});

test('SVG 里关联线标签画在节点之后（不会被框挡住），底框实心', () => {
  const doc = sampleDoc();
  const a = doc.nodes[1];
  const b = doc.nodes[3];
  addEdge(doc, { from: a.id, to: b.id, label: '影响' });
  const layout = layoutDoc(doc);
  const relation = layout.edges.find((edge) => edge.kind === 'relation');
  const box = relation.labelBox;
  const svg = docToSvg(doc);

  // 标签必须在最后一个节点组之后
  assert.ok(svg.indexOf('>影响<') > svg.lastIndexOf('</g>'), '标签应画在所有节点之后');

  const match = /<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)" rx="(?:[\d.]+)" fill="[^"]+" stroke="[^"]+" stroke-width="(?:[\d.]+)"\/><text x="(?:[\d.]+)" y="(?:[\d.]+)"[^>]*>影响<\/text>/.exec(svg);
  assert.ok(match, '应能找到关联线标签的底框');
  const [x, y, w, h] = match.slice(1).map(Number);
  close(x, box.x, 0.6);
  close(y, box.y, 0.6);
  close(w, box.width, 0.6);
  close(h, box.height, 0.6);
  // 底框必须是实心（没有 opacity 半透明），否则盖不住曲线
  assert.ok(!/rx="(?:[\d.]+)" fill="[^"]+" stroke="[^"]+" stroke-width="(?:[\d.]+)" opacity=/.test(svg), '标签底框不应是半透明');
});

test('treePath 输出三次贝塞尔', () => {
  const doc = sampleDoc();
  const layout = layoutDoc(doc);
  const tree = layout.edges.find((edge) => edge.kind === 'tree');
  assert.match(treePath(tree), /^M .* C .*,.*,.*$/);
});

test('renderSvg 为每个节点输出 data-node-id 且转义文本', () => {
  const doc = createDoc({ title: '转义', rootText: '根' });
  addNode(doc, { parent: 'root', text: 'A & B <script>alert(1)</script>' });
  const svg = docToSvg(doc);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  for (const node of doc.nodes) assert.match(svg, new RegExp(`data-node-id="${node.id}"`));
  assert.equal(svg.includes('<script>'), false);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /<rect/);
  assert.match(svg, /<\/svg>$/);
  assert.equal(esc('"\'&<>'), '&quot;&#39;&amp;&lt;&gt;');
});

test('renderSvg 使用自定义的模块/字体/连线颜色', () => {
  const doc = createDoc({ title: '颜色', rootText: '根' });
  const node = addNode(doc, { parent: 'root', text: '带颜色' });
  const child = addNode(doc, { parent: node.id, text: '子节点' });
  updateNode(doc, { id: node.id, color: '#fecdd3', textColor: '#b91c1c', lineColor: '#0ea5e9' });
  const svg = docToSvg(doc);
  assert.match(svg, /fill="#fecdd3"/, '模块底色');
  assert.match(svg, /fill="#b91c1c"/, '字体色');
  assert.match(svg, /stroke="#0ea5e9"/, '连线色');
  // 子节点继承了父节点的连线色，所以这条线也是蓝的
  const edgeCount = (svg.match(/stroke="#0ea5e9"/g) ?? []).length;
  assert.equal(edgeCount, 2, `父→子 和 根→父 两条线都应为自定义色，实际 ${edgeCount}`);
  void child;
});

test('renderSvg 每个节点用自己的字体和字号', () => {
  const doc = createDoc({ title: '字体', rootText: '根' });
  const a = addNode(doc, { parent: 'root', text: '楷体节点' });
  const b = addNode(doc, { parent: 'root', text: '普通节点' });
  updateNode(doc, { id: a.id, font: 'kai', fontSize: 28 });
  const svg = docToSvg(doc);
  assert.match(svg, /font-family="[^"]*Kaiti[^"]*"/, '楷体栈出现在 SVG 里');
  assert.match(svg, /font-size="28"/, '自定义字号出现在 SVG 里');
  assert.equal((svg.match(/font-size="28"/g) ?? []).length, 1, '只有设置了字号的节点才是 28');
  void b;
});

test('renderSvg 背景开关与 linkHref', () => {
  const doc = createDoc({ title: 'x', rootText: '根' });
  const node = addNode(doc, { parent: 'root', text: '带链接', links: [{ kind: 'url', target: 'https://example.com' }] });
  const noBg = docToSvg(doc, { background: false });
  assert.equal(noBg.includes('<rect x="0" y="0" width='), false, '不应有整页背景矩形');
  const withLinks = docToSvg(doc, { linkHref: (item) => item.links[0]?.target ?? null });
  assert.match(withLinks, /<a href="https:\/\/example\.com"/);
  void node;
});

test('真实中文长文本不会让节点宽度爆炸', () => {
  const doc = createDoc({ title: '长文本', rootText: '一项关于多模态大模型在弱监督条件下视觉语言对齐能力的研究' });
  const layout = layoutDoc(doc);
  assert.ok(layout.nodes[0].width <= 260 + 1);
  assert.ok(layout.nodes[0].lines.length >= 2);
  assert.ok(layout.height > 40);
});
