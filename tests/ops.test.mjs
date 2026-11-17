import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, getNode, childrenOf, normalizeDoc, DocError } from '../src/core/doc.mjs';
import {
  addNode,
  addChildren,
  updateNode,
  removeNode,
  moveNode,
  reorderNode,
  addEdge,
  updateEdge,
  removeEdge,
  setDoc,
  applyOps,
  OP_NAMES,
} from '../src/core/ops.mjs';

const base = () => {
  const doc = createDoc({ title: '测试', rootText: '根' });
  const a = addNode(doc, { parent: 'root', text: 'A' });
  const b = addNode(doc, { parent: 'root', text: 'B' });
  const a1 = addNode(doc, { parent: a.id, text: 'A1' });
  return { doc, a, b, a1 };
};

test('addNode 默认挂到根并追加到末尾', () => {
  const { doc, a, b } = base();
  const c = addNode(doc, { text: 'C' });
  assert.equal(c.parent, 'root');
  assert.deepEqual(childrenOf(doc, 'root').map((node) => node.text), ['A', 'B', 'C']);
  assert.equal(childrenOf(doc, 'root')[0].id, a.id);
  assert.equal(childrenOf(doc, 'root')[1].id, b.id);
});

test('addNode 支持 position=start / 数字', () => {
  const { doc, a, b } = base();
  const start = addNode(doc, { parent: 'root', text: 'first', position: 'start' });
  assert.equal(childrenOf(doc, 'root')[0].id, start.id);
  const middle = addNode(doc, { parent: 'root', text: 'mid', position: 1 });
  assert.deepEqual(childrenOf(doc, 'root').map((node) => node.text), ['first', 'mid', 'A', 'B']);
  void a;
  void b;
});

test('addNode 缺文字时用占位符而不是空', () => {
  const { doc } = base();
  const node = addNode(doc, { parent: 'root' });
  assert.equal(node.text, '新节点');
  const empty = addNode(doc, { parent: 'root', text: '   ' });
  assert.equal(empty.text, '(空)');
});

test('addNode 拒绝重复 id 和不存在的父节点', () => {
  const { doc, a } = base();
  assert.throws(() => addNode(doc, { parent: 'root', id: a.id, text: 'x' }), /已存在/);
  assert.throws(() => addNode(doc, { parent: 'nope', text: 'x' }), /父节点不存在/);
});

test('addChildren 批量添加', () => {
  const { doc, a } = base();
  const created = addChildren(doc, { parent: a.id, texts: ['x', 'y', 'z'] });
  assert.equal(created.length, 3);
  assert.deepEqual(childrenOf(doc, a.id).map((node) => node.text), ['A1', 'x', 'y', 'z']);
});

test('updateNode 只改传入字段', () => {
  const { doc, a } = base();
  updateNode(doc, { id: a.id, note: '备注' });
  assert.equal(getNode(doc, a.id).text, 'A');
  assert.equal(getNode(doc, a.id).note, '备注');
  updateNode(doc, { id: a.id, links: ['https://x.com', { kind: 'code', target: 'a.py' }] });
  assert.equal(getNode(doc, a.id).links.length, 2);
  updateNode(doc, { id: a.id, color: '#ff0000' });
  assert.equal(getNode(doc, a.id).color, '#ff0000');
  updateNode(doc, { id: a.id, color: '' });
  assert.equal(getNode(doc, a.id).color, undefined);
  updateNode(doc, { id: a.id, collapsed: true });
  assert.equal(getNode(doc, a.id).collapsed, true);
});

test('updateNode 支持字体色和连线色，且能清除', () => {
  const { doc, a } = base();
  updateNode(doc, { id: a.id, textColor: '#B91C1C', lineColor: '#0ea5e9' });
  assert.equal(getNode(doc, a.id).textColor, '#b91c1c');
  assert.equal(getNode(doc, a.id).lineColor, '#0ea5e9');
  updateNode(doc, { id: a.id, textColor: '' });
  assert.equal(getNode(doc, a.id).textColor, undefined, '传空串等于清除');
  updateNode(doc, { id: a.id, lineColor: 'bogus' });
  assert.equal(getNode(doc, a.id).lineColor, undefined, '非法值也等于清除');
});

test('updateNode 的 subtree 模式把颜色套到整棵子树', () => {
  const { doc, a, a1 } = base();
  const deeper = addNode(doc, { parent: a1.id, text: 'A1a' });
  const other = addNode(doc, { parent: 'root', text: '另一个分支' });

  updateNode(doc, { id: a.id, subtree: true, color: '#fecdd3', lineColor: '#0ea5e9' });
  for (const id of [a.id, a1.id, deeper.id]) {
    assert.equal(getNode(doc, id).color, '#fecdd3', `${id} 应该被染色`);
    assert.equal(getNode(doc, id).lineColor, '#0ea5e9', `${id} 的连线色应该被改`);
  }
  assert.equal(getNode(doc, other.id).color, undefined, '兄弟分支不受影响');

  // 子树模式只允许颜色字段
  assert.throws(() => updateNode(doc, { id: a.id, subtree: true, text: '不许改' }), /只能改颜色/);
  assert.throws(() => updateNode(doc, { id: a.id, subtree: true }), /至少要给一个颜色/);
});

test('新建节点默认沿用空间上前一个节点的颜色（不是父节点）', () => {
  const doc = createDoc({ title: '继承颜色', rootText: '根' });
  const first = addNode(doc, { parent: 'root', text: '第一个' });
  updateNode(doc, { id: first.id, color: '#fecdd3' });

  // 追加到最后一个位置 → 和前一个同级节点同色
  const second = addNode(doc, { parent: 'root', text: '第二个' });
  assert.equal(second.color, '#fecdd3');
  // 再追加 → 仍和前一个（第二个）一致，颜色会一路延续
  const third = addNode(doc, { parent: 'root', text: '第三个' });
  assert.equal(third.color, '#fecdd3');

  // 插到最前面：前面没有同级节点，此时"上一个"是父节点（根没设颜色 → 不继承）
  const top = addNode(doc, { parent: 'root', text: '插到最前', position: 'start' });
  assert.equal(top.color, undefined, '根节点没有颜色，最前面的节点不应凭空有颜色');

  // 第一个子节点：上一个节点是父节点，跟父节点同色
  const child1 = addNode(doc, { parent: first.id, text: '子一' });
  assert.equal(child1.color, '#fecdd3', '父节点有颜色时，第一个子节点跟父节点一致');
  // 第二个子节点：上一个节点是兄弟节点
  const child2 = addNode(doc, { parent: first.id, text: '子二' });
  assert.equal(child2.color, '#fecdd3');

  // 显式给的 color 优先
  const explicit = addNode(doc, { parent: 'root', text: '指定色', color: '#bfdbfe' });
  assert.equal(explicit.color, '#bfdbfe');

  // 前一个节点没颜色时也不乱给颜色
  const plain = addNode(doc, { parent: 'root', text: '无色的前一个' });
  const afterPlain = addNode(doc, { parent: 'root', text: '跟在后头' });
  assert.equal(plain.color, '#bfdbfe', '延续显式色');
  assert.equal(afterPlain.color, '#bfdbfe');
});

test('updateNode 支持批注，传空串可以清掉', () => {
  const { doc, a } = base();
  updateNode(doc, { id: a.id, annotation: '改成两个节点' });
  assert.equal(getNode(doc, a.id).annotation, '改成两个节点');
  updateNode(doc, { id: a.id, annotation: '  带空格的批注  ' });
  assert.equal(getNode(doc, a.id).annotation, '带空格的批注', '首尾空白要剪掉');
  updateNode(doc, { id: a.id, annotation: '' });
  assert.equal(getNode(doc, a.id).annotation, undefined, '空串等于清空');
  // 批注只对单节点，不能整枝套用
  assert.throws(() => updateNode(doc, { id: a.id, subtree: true, annotation: '整枝' }), /只能改颜色/);
});

test('updateNode 支持字号、字体、框宽高，空串即恢复自动', () => {
  const { doc, a } = base();
  updateNode(doc, { id: a.id, fontSize: 22, font: 'kai', boxWidth: 200, boxHeight: 80 });
  assert.equal(getNode(doc, a.id).fontSize, 22);
  assert.equal(getNode(doc, a.id).font, 'kai');
  assert.equal(getNode(doc, a.id).boxWidth, 200);
  assert.equal(getNode(doc, a.id).boxHeight, 80);

  updateNode(doc, { id: a.id, fontSize: '', font: '', boxWidth: '', boxHeight: '' });
  const cleared = getNode(doc, a.id);
  assert.equal(cleared.fontSize, undefined);
  assert.equal(cleared.font, undefined);
  assert.equal(cleared.boxWidth, undefined);
  assert.equal(cleared.boxHeight, undefined);

  updateNode(doc, { id: a.id, fontSize: 999, boxWidth: 1 });
  assert.equal(getNode(doc, a.id).fontSize, 48, '字号会被夹到上限');
  assert.equal(getNode(doc, a.id).boxWidth, 44, '框宽会被夹到下限');
  updateNode(doc, { id: a.id, font: 'not-a-font' });
  assert.equal(getNode(doc, a.id).font, undefined, '未知字体等于清除');
});

test('subtree 可以整枝改字号和字体，但不接受框尺寸', () => {
  const { doc, a, a1 } = base();
  const deeper = addNode(doc, { parent: a1.id, text: 'A1a' });
  updateNode(doc, { id: a.id, subtree: true, fontSize: 16, font: 'song' });
  for (const id of [a.id, a1.id, deeper.id]) {
    assert.equal(getNode(doc, id).fontSize, 16);
    assert.equal(getNode(doc, id).font, 'song');
  }
  assert.throws(() => updateNode(doc, { id: a.id, subtree: true, boxWidth: 120 }), /只能改颜色 \/ 字号 \/ 字体/);
  // 颜色和字号可以一起套用
  updateNode(doc, { id: a.id, subtree: true, color: '#fecdd3', fontSize: 14 });
  assert.equal(getNode(doc, deeper.id).color, '#fecdd3');
  assert.equal(getNode(doc, deeper.id).fontSize, 14);
});

test('removeNode 默认删子树，并清理关联线', () => {
  const { doc, a, b } = base();
  addEdge(doc, { from: a.id, to: b.id, label: '关联' });
  const result = removeNode(doc, { id: a.id });
  assert.equal(result.removed.length, 2);
  assert.equal(getNode(doc, a.id), null);
  assert.equal(getNode(doc, 'n_deadbeef'), null);
  assert.equal(doc.edges.length, 0);
  assert.deepEqual(childrenOf(doc, 'root').map((node) => node.text), ['B']);
});

test('removeNode 可以把子节点改挂后再删', () => {
  const { doc, a, b, a1 } = base();
  removeNode(doc, { id: a.id, reparentChildren: true, parent: b.id });
  assert.equal(getNode(doc, a.id), null);
  assert.equal(getNode(doc, a1.id).parent, b.id);
});

test('removeNode 不能删根', () => {
  const { doc } = base();
  assert.throws(() => removeNode(doc, { id: 'root' }), /不能删除根节点/);
});

test('moveNode 变换父节点并拒绝环', () => {
  const { doc, a, b, a1 } = base();
  assert.throws(() => moveNode(doc, { id: a.id, parent: a1.id }), /子树/);
  assert.throws(() => moveNode(doc, { id: 'root', parent: b.id }), /根节点/);
  assert.throws(() => moveNode(doc, { id: b.id, parent: b.id }), /自己/);
  moveNode(doc, { id: a1.id, parent: b.id });
  assert.equal(getNode(doc, a1.id).parent, b.id);
});

test('reorderNode 上下移动', () => {
  const { doc, a, b } = base();
  reorderNode(doc, { id: b.id, direction: 'up' });
  assert.deepEqual(childrenOf(doc, 'root').map((node) => node.text), ['B', 'A']);
  reorderNode(doc, { id: b.id, direction: 'up' });
  assert.deepEqual(childrenOf(doc, 'root').map((node) => node.text), ['B', 'A'], '已在最上面时不变');
  reorderNode(doc, { id: a.id, direction: 'down' });
  assert.deepEqual(childrenOf(doc, 'root').map((node) => node.text), ['B', 'A'], '已在最下面时不变');
  reorderNode(doc, { id: b.id, direction: 'down' });
  assert.deepEqual(childrenOf(doc, 'root').map((node) => node.text), ['A', 'B']);
});

test('关联线增改删', () => {
  const { doc, a, b } = base();
  const edge = addEdge(doc, { from: a.id, to: b.id, label: '验证' });
  assert.equal(edge.label, '验证');
  assert.throws(() => addEdge(doc, { from: a.id, to: a.id }), /同一个节点/);
  updateEdge(doc, { id: edge.id, label: '改为' });
  assert.equal(doc.edges[0].label, '改为');
  removeEdge(doc, { id: edge.id });
  assert.equal(doc.edges.length, 0);
  assert.throws(() => removeEdge(doc, { id: 'nope' }), /不存在/);
});

test('setDoc 改标题/布局/主题并校验', () => {
  const { doc } = base();
  setDoc(doc, { title: '新标题', layout: 'both', theme: 'dark' });
  assert.equal(doc.title, '新标题');
  assert.equal(doc.settings.layout, 'both');
  assert.equal(doc.settings.theme, 'dark');
  assert.throws(() => setDoc(doc, { layout: 'diagonal' }), /未知布局/);
  assert.throws(() => setDoc(doc, { theme: 'neon' }), /未知主题/);
});

test('setDoc 支持改标签（数组 / 字符串 / 清空）', () => {
  const { doc } = base();
  setDoc(doc, { tags: ['论文', ' 第 3 章 ', '论文'] });
  assert.deepEqual(doc.tags, ['论文', '第 3 章']);
  setDoc(doc, { tags: 'a, b；c' });
  assert.deepEqual(doc.tags, ['a', 'b', 'c']);
  setDoc(doc, { tags: [] });
  assert.deepEqual(doc.tags, []);
  // 不传 tags 时不动原有标签
  setDoc(doc, { tags: ['x'] });
  setDoc(doc, { title: '只改标题' });
  assert.deepEqual(doc.tags, ['x']);
});

test('applyOps 可以一次改标题和标签', () => {
  const { doc } = base();
  const { doc: next } = applyOps(doc, [{ op: 'setDoc', title: '新标题', tags: ['a', 'b'] }]);
  assert.equal(next.title, '新标题');
  assert.deepEqual(next.tags, ['a', 'b']);
});

test('applyOps 原子生效，出错时原文档不变', () => {
  const { doc } = base();
  const snapshot = JSON.stringify(doc);
  assert.throws(
    () =>
      applyOps(doc, [
        { op: 'addNode', parent: 'root', text: 'ok' },
        { op: 'updateNode', id: 'missing', text: 'bad' },
      ]),
    /节点不存在/,
  );
  assert.equal(JSON.stringify(doc), snapshot, '失败时不应修改原文档');
});

test('applyOps 支持全部 op 名称', () => {
  const { doc, a, b } = base();
  const { doc: next, results } = applyOps(doc, [
    { op: 'addNode', parent: 'root', text: 'C' },
    { op: 'updateNode', id: a.id, text: 'A*' },
    { op: 'moveNode', id: b.id, parent: a.id },
    { op: 'reorderNode', id: a.id, direction: 'down' },
    { op: 'addEdge', from: a.id, to: b.id },
    { op: 'setDoc', title: 'T2' },
  ]);
  assert.equal(results.length, 6);
  assert.equal(next.title, 'T2');
  assert.equal(getNode(next, a.id).text, 'A*');
  assert.equal(getNode(next, b.id).parent, a.id);
  assert.equal(next.edges.length, 1);
  assert.deepEqual(OP_NAMES.length, 10);
});

test('applyOps 拒绝未知 op 和非法输入', () => {
  const { doc } = base();
  assert.throws(() => applyOps(doc, [{ op: 'explode' }]), /未知 op/);
  assert.throws(() => applyOps(doc, 'not-array'), /数组/);
  assert.throws(() => applyOps(doc, [null]), /对象/);
  assert.throws(() => applyOps(doc, [{ op: 'addEdge', from: 'root', to: 'nope' }]), /节点不存在/);
});

test('applyOps 兼容 type 作为 op 别名', () => {
  const { doc } = base();
  const { doc: next } = applyOps(doc, [{ type: 'addNode', parent: 'root', text: 'by-type' }]);
  assert.ok(next.nodes.some((node) => node.text === 'by-type'));
});

test('normalizeDoc 后 op 仍然可用（空文档也能加节点）', () => {
  const doc = normalizeDoc({});
  const node = addNode(doc, { text: '第一个' });
  assert.equal(node.parent, 'root');
  assert.equal(doc.nodes.length, 2);
});
