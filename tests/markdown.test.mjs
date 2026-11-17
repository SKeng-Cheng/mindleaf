import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromMarkdown, toMarkdown, guessTitle } from '../src/core/markdown.mjs';
import { childrenOf, getNode, rootOf, docIssues, createDoc } from '../src/core/doc.mjs';
import { addNode } from '../src/core/ops.mjs';

test('fromMarkdown 标题层级变成树', () => {
  const md = `# 论文\n\n## 第一章\n\n### 小节\n\n## 第二章\n`;
  const doc = fromMarkdown(md);
  assert.equal(doc.title, '论文');
  assert.equal(rootOf(doc).text, '论文');
  const chapters = childrenOf(doc, rootOf(doc).id);
  assert.deepEqual(chapters.map((node) => node.text), ['第一章', '第二章']);
  assert.deepEqual(childrenOf(doc, chapters[0].id).map((node) => node.text), ['小节']);
  assert.deepEqual(docIssues(doc), []);
});

test('fromMarkdown 列表项变备注，链接被抽出来', () => {
  const md = `# 根\n\n## 节点\n\n- 第一条\n- 第二条\n- [架构说明](docs/architecture.md)\n- 见 https://example.com\n`;
  const doc = fromMarkdown(md);
  const node = childrenOf(doc, 'root')[0];
  assert.match(node.note, /第一条/);
  assert.match(node.note, /第二条/);
  assert.equal(node.links.length, 2, 'Markdown 链接 + 裸 URL 都应被识别');
  assert.equal(node.links[0].kind, 'file');
  assert.equal(node.links[0].target, 'docs/architecture.md');
  assert.equal(node.links[0].label, '架构说明');
});

test('fromMarkdown 兼容没有一级标题的输入', () => {
  const md = `## 甲\n### 甲一\n## 乙\n`;
  const doc = fromMarkdown(md, { title: '合成标题' });
  assert.equal(doc.nodes.filter((node) => node.parent == null).length, 1);
  assert.deepEqual(docIssues(doc), []);
});

test('fromMarkdown 跳过代码块内容并保留为备注', () => {
  const md = `# 根\n\n## 代码\n\n\`\`\`js\nconst a = 1;\n# 这不是标题\n\`\`\`\n`;
  const doc = fromMarkdown(md);
  const node = childrenOf(doc, 'root')[0];
  assert.equal(node.text, '代码');
  assert.match(node.note, /const a = 1/);
  assert.match(node.note, /# 这不是标题/);
  assert.equal(childrenOf(doc, 'root').length, 1);
});

test('fromMarkdown 忽略 front matter', () => {
  const md = `---\ntitle: 元数据\n---\n# 真标题\n\n## A\n`;
  const doc = fromMarkdown(md);
  assert.equal(rootOf(doc).text, '真标题');
  assert.equal(childrenOf(doc, doc.nodes[0].id).length, 1);
});

test('toMarkdown 与 fromMarkdown 往返基本保真', () => {
  const doc = fromMarkdown(`# 论文\n\n## 第一章\n\n- 备注一\n\n### 小节\n\n- 备注二\n`);
  const md = toMarkdown(doc);
  const again = fromMarkdown(md);
  assert.equal(again.title, doc.title);
  const texts = (d) => d.nodes.map((node) => node.text).sort();
  assert.deepEqual(texts(again), texts(doc));
  const notes = (d) => d.nodes.map((node) => node.note.trim()).filter(Boolean).sort();
  assert.deepEqual(notes(again), notes(doc));
  assert.match(md, /^# 论文/m);
  assert.match(md, /^## 第一章/m);
  assert.match(md, /^### 小节/m);
});

test('toMarkdown 保留链接为 Markdown 链接', () => {
  const doc = fromMarkdown(`# 根\n\n## A\n\n- [arXiv](https://arxiv.org/abs/1)\n`);
  const md = toMarkdown(doc);
  assert.match(md, /\[arXiv\]\(https:\/\/arxiv\.org\/abs\/1\)/);
});

test('toMarkdown 限制标题层级不超过 6 级', () => {
  const doc = createDoc({ title: '深树', rootText: 'L0' });
  let parent = 'root';
  for (let i = 1; i <= 8; i += 1) parent = addNode(doc, { parent, text: `L${i}` }).id;
  const out = toMarkdown(doc);
  assert.equal(/^#{7,}\s/m.test(out), false);
  assert.match(out, /^#{6}\s/m);
});

test('guessTitle 取第一个标题', () => {
  assert.equal(guessTitle('# 你好\n## 世界'), '你好');
  assert.equal(guessTitle('没有标题'), null);
});

test('中文标题与内容不乱码', () => {
  const md = '# 项目规划\n\n## 第一步：梳理现状\n\n- 重点：先摸清依赖关系。\n';
  const doc = fromMarkdown(md);
  const text = toMarkdown(doc);
  assert.match(text, /项目规划/);
  assert.match(text, /先摸清依赖关系/);
  assert.equal(getNode(doc, 'root').text, '项目规划');
});
