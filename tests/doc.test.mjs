import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDoc,
  normalizeDoc,
  normalizeTags,
  normalizeHexColor,
  annotationsOf,
  edgeAnnotationsOf,
  ANNOTATION_MAX,
  tagsToText,
  FONTS,
  FONT_KEYS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  BOX_WIDTH_MIN,
  BOX_WIDTH_MAX,
  newNodeId,
  guessLinkKind,
  recordChange,
  outline,
  docStats,
  docIssues,
  eachNode,
  getNode,
  rootOf,
  subtreeIds,
  isDescendant,
  depthOf,
  childrenOf,
  SCHEMA_VERSION,
} from '../src/core/doc.mjs';
import { addNode, updateNode } from '../src/core/ops.mjs';

test('createDoc 生成合法文档', () => {
  const doc = createDoc({ title: '论文', rootText: '根' });
  assert.equal(doc.format, 'mindmap');
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  assert.equal(doc.title, '论文');
  assert.equal(doc.nodes.length, 1);
  assert.equal(doc.nodes[0].id, 'root');
  assert.equal(doc.nodes[0].text, '根');
  assert.equal(doc.nodes[0].parent, null);
  assert.equal(doc.journal.length, 1);
  assert.deepEqual(docIssues(doc), []);
});

test('normalizeDoc 修复孤儿节点、多根、自环和无 id', () => {
  const doc = normalizeDoc({
    title: '修',
    nodes: [
      { id: 'a', parent: null, text: 'A' },
      { id: 'b', parent: 'missing', text: 'B' },
      { parent: 'a', text: 'C' },
      { id: 'a', parent: 'a', text: '重复 id' },
      { id: 'x', parent: 'x', text: '自环' },
    ],
  });
  const roots = doc.nodes.filter((node) => node.parent == null);
  assert.equal(roots.length, 1);
  const ids = doc.nodes.map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(docIssues(doc), []);
});

test('normalizeDoc 修复环（a->b->a）', () => {
  const doc = normalizeDoc({
    nodes: [
      { id: 'root', parent: null, text: 'root' },
      { id: 'a', parent: 'b', text: 'A' },
      { id: 'b', parent: 'a', text: 'B' },
      { id: 'c', parent: 'x', text: 'C' },
    ],
  });
  assert.equal(doc.nodes.filter((node) => node.parent == null).length, 1);
  assert.deepEqual(docIssues(doc), []);
});

test('normalizeDoc 清理非法链接与关联线', () => {
  const doc = normalizeDoc({
    nodes: [
      { id: 'root', parent: null, text: 'r', links: ['https://a.com', '  ', { target: 'x.md' }, { kind: 'bogus', target: 'y.py' }] },
      { id: 'b', parent: 'root', text: 'b' },
    ],
    edges: [{ from: 'root', to: 'b' }, { from: 'root', to: 'nope' }, { from: 'b', to: 'b' }],
  });
  assert.equal(doc.nodes[0].links.length, 3);
  assert.deepEqual(
    doc.nodes[0].links.map((link) => link.kind),
    ['url', 'file', 'code'],
  );
  assert.equal(doc.edges.length, 1);
});

test('guessLinkKind 识别 url / file / code', () => {
  assert.equal(guessLinkKind('https://arxiv.org/abs/1'), 'url');
  assert.equal(guessLinkKind('docs/architecture.md'), 'file');
  assert.equal(guessLinkKind('src/core/doc.mjs'), 'code');
  assert.equal(guessLinkKind('src/core/doc.mjs#L10-L20'), 'code');
  assert.equal(guessLinkKind('/tmp/a.py:12'), 'code');
});

test('遍历与统计', () => {
  const doc = normalizeDoc({
    nodes: [
      { id: 'root', parent: null, text: 'r' },
      { id: 'a', parent: 'root', text: 'a' },
      { id: 'a1', parent: 'a', text: 'a1' },
      { id: 'b', parent: 'root', text: 'b', collapsed: true },
    ],
  });
  assert.deepEqual(
    eachNode(doc).map((item) => item.node.id),
    ['root', 'a', 'a1', 'b'],
  );
  assert.equal(depthOf(doc, 'a1'), 2);
  assert.deepEqual(childrenOf(doc, 'root').map((node) => node.id), ['a', 'b']);
  assert.deepEqual(subtreeIds(doc, 'a'), ['a', 'a1']);
  assert.equal(isDescendant(doc, 'root', 'a1'), true);
  assert.equal(isDescendant(doc, 'a1', 'root'), false);
  assert.equal(rootOf(doc).id, 'root');
  assert.deepEqual(docStats(doc), { nodes: 4, edges: 0, maxDepth: 2, collapsed: 1, annotations: 0 });
});

test('outline 带 id 与链接', () => {
  const doc = normalizeDoc({
    nodes: [
      { id: 'root', parent: null, text: '论文' },
      { id: 'a', parent: 'root', text: '第一章', note: '备注行', links: [{ kind: 'file', target: 'a.md', label: '文件' }] },
    ],
  });
  const text = outline(doc, { withNotes: true });
  assert.match(text, /论文 〔root〕/);
  assert.match(text, /第一章 〔a〕/);
  assert.match(text, /! 备注行/);
  assert.match(text, /file:a\.md \(文件\)/);
});

test('newNodeId 不与已有节点冲突', () => {
  const doc = createDoc({ title: 'x' });
  const ids = new Set(['n']);
  for (let i = 0; i < 50; i += 1) {
    const id = newNodeId(doc, 'n');
    assert.equal(ids.has(id), false);
    ids.add(id);
    doc.nodes.push({ id, parent: 'root', text: 'x', order: i, links: [] });
  }
});

test('normalizeTags 去空白、去 #、忽略大小写去重、限长限量', () => {
  assert.deepEqual(normalizeTags(['  论文 ', '#第3章', '论文', '', '  ']), ['论文', '第3章']);
  assert.deepEqual(normalizeTags('a, b；c'), ['a', 'b', 'c']);
  assert.deepEqual(normalizeTags(undefined), []);
  assert.deepEqual(normalizeTags(null), []);
  assert.deepEqual(normalizeTags([1, 2]), ['1', '2']);
  assert.deepEqual(normalizeTags(['Foo', 'foo']), ['Foo'], '忽略大小写去重');
  const long = normalizeTags(['x'.repeat(40)]);
  assert.equal(long[0].length, 24, '单个标签限长 24');
  const many = normalizeTags(Array.from({ length: 40 }, (_, i) => `t${i}`));
  assert.equal(many.length, 24, '最多 24 个标签');
  assert.equal(tagsToText(['a', ' b ']), 'a, b');
});

test('文档带 tags：normalizeDoc 保留并清洗，createDoc 可以直接给', () => {
  const created = createDoc({ title: 't', tags: [' 项目 ', '项目', '架构'] });
  assert.deepEqual(created.tags, ['项目', '架构']);
  const doc = normalizeDoc({ title: 'x', tags: ['a', 'a', '#b'], nodes: [{ id: 'root', parent: null, text: 'r' }] });
  assert.deepEqual(doc.tags, ['a', 'b']);
  const noTags = normalizeDoc({ title: 'y', nodes: [{ id: 'root', parent: null, text: 'r' }] });
  assert.deepEqual(noTags.tags, []);
});

test('节点三种颜色都会归一化，非法值丢弃', () => {
  assert.equal(normalizeHexColor('#ABC'), '#abc');
  assert.equal(normalizeHexColor(' #2563EB '), '#2563eb');
  assert.equal(normalizeHexColor('red'), '');
  assert.equal(normalizeHexColor(undefined), '');
  const doc = normalizeDoc({
    nodes: [
      { id: 'root', parent: null, text: 'r', color: '#FFF', textColor: '#B91C1C', lineColor: '#0ea5e9' },
      { id: 'a', parent: 'root', text: 'a', color: 'not-a-color', textColor: 123 },
    ],
  });
  const root = doc.nodes[0];
  assert.equal(root.color, '#fff');
  assert.equal(root.textColor, '#b91c1c');
  assert.equal(root.lineColor, '#0ea5e9');
  const child = doc.nodes[1];
  assert.equal(child.color, undefined);
  assert.equal(child.textColor, undefined);
  assert.equal(child.lineColor, undefined);
});

test('字号、字体、框宽高都会被归一化并夹到合法范围内', () => {
  assert.ok(FONT_KEYS.includes('system'));
  assert.ok(Object.values(FONTS).every((item) => item.stack && item.label), '每个字体都要有标签和字体栈');

  const doc = normalizeDoc({
    nodes: [
      { id: 'root', parent: null, text: 'r', fontSize: 999, font: 'kai', boxWidth: 5, boxHeight: 9999 },
      { id: 'a', parent: 'root', text: 'a', fontSize: '20', font: 'nope' },
      { id: 'b', parent: 'root', text: 'b', fontSize: 'big', boxWidth: 'x' },
    ],
  });
  const [root, a, b] = doc.nodes;
  assert.equal(root.fontSize, FONT_SIZE_MAX, '字号上限');
  assert.equal(root.font, 'kai');
  assert.equal(root.boxWidth, BOX_WIDTH_MIN, '框宽下限');
  assert.equal(root.boxHeight, 500, '框高上限');
  assert.equal(a.fontSize, 20, '字符串数字也认');
  assert.equal(a.font, undefined, '未知字体丢掉');
  assert.equal(b.fontSize, undefined, '非数字丢掉');
  assert.equal(b.boxWidth, undefined);
});

test('批注会归一化：去首尾空白、超长截断、空串丢弃', () => {
  const doc = normalizeDoc({
    nodes: [
      { id: 'root', parent: null, text: 'r', annotation: '  把三个子节点合并成两个  ' },
      { id: 'a', parent: 'root', text: 'a', annotation: '   ' },
      { id: 'b', parent: 'root', text: 'b', annotation: 'x'.repeat(ANNOTATION_MAX + 100) },
      { id: 'c', parent: 'root', text: 'c' },
    ],
  });
  assert.equal(doc.nodes[0].annotation, '把三个子节点合并成两个');
  assert.equal(doc.nodes[1].annotation, undefined, '纯空白等于没有批注');
  assert.equal(doc.nodes[2].annotation.length, ANNOTATION_MAX, '超长要截断');
  assert.equal(doc.nodes[3].annotation, undefined);
  assert.equal(docStats(doc).annotations, 2);
});

test('outline 会带出批注，annotationsOf 按树的顺序返回', () => {
  const doc = createDoc({ title: 't', rootText: '根' });
  const a = addNode(doc, { parent: 'root', text: 'A' });
  const a1 = addNode(doc, { parent: a.id, text: 'A1' });
  updateNode(doc, { id: a.id, annotation: '第一行要求\n第二行要求' });
  updateNode(doc, { id: a1.id, annotation: '子节点也要改' });

  const text = outline(doc);
  assert.match(text, /⚑ 批注: 第一行要求/);
  assert.match(text, /第二行要求/);
  assert.match(text, /⚑ 批注: 子节点也要改/);
  assert.match(outline(doc, { withAnnotations: false }), /^[\s\S]*$/, '可以关掉');
  assert.ok(!outline(doc, { withAnnotations: false }).includes('⚑'), 'withAnnotations: false 不显示');

  const list = annotationsOf(doc);
  assert.deepEqual(list.map((item) => item.id), [a.id, a1.id], '按树的先序排列');
  assert.equal(list[0].text, 'A');
});

test('关联线支持颜色/备注/批注，归一化会保留', () => {
  const doc = normalizeDoc({
    nodes: [
      { id: 'root', parent: null, text: '根' },
      { id: 'a', parent: 'root', text: 'A' },
      { id: 'b', parent: 'root', text: 'B' },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', label: ' 核对 ', color: '#BE123C', note: ' 备注 ', annotation: ' 改一下 ' },
      { id: 'e2', from: 'a', to: 'b', color: 'nope' },
    ],
  });
  const [first, second] = doc.edges;
  assert.equal(first.label, '核对');
  assert.equal(first.color, '#be123c', '颜色要小写归一化');
  assert.equal(first.note, '备注');
  assert.equal(first.annotation, '改一下');
  assert.equal(second.color, undefined, '非法颜色丢掉');
  assert.equal(second.label, undefined);
  assert.deepEqual(edgeAnnotationsOf(doc).map((item) => item.id), ['e1']);
});

test('recordChange 递增 rev 并裁剪 journal', () => {
  const doc = createDoc({ title: 'x' });
  for (let i = 0; i < 260; i += 1) recordChange(doc, { by: 'test', action: 'touch', summary: `#${i}` });
  assert.equal(doc.rev, 260);
  assert.ok(doc.journal.length <= 200);
  assert.equal(doc.journal.at(-1).rev, 260);
  assert.equal(getNode(doc, 'root').id, 'root');
});
