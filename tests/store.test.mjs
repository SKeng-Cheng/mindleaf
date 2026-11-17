import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, StoreError, findProjectRoot, diffNodes, MAP_EXT, CONFIG_FILE } from '../src/server/store.mjs';
import { listTemplates, getTemplate, docFromTemplate } from '../src/server/templates.mjs';
import { addNode } from '../src/core/ops.mjs';
import { docStats } from '../src/core/doc.mjs';

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindleaf-store-'));
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify({ version: 1, mapsDir: 'maps', exportsDir: 'exports' }), 'utf8');
  return new Store({ projectDir: dir }).init();
}

test('create/list/read 基本闭环', () => {
  const store = tempProject();
  const created = store.create({ title: '论文大纲' });
  assert.ok(fs.existsSync(created.file));
  assert.match(created.file, new RegExp(`${MAP_EXT}$`));
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '论文大纲');
  assert.equal(list[0].nodes, 1);
  const read = store.read('论文大纲');
  assert.equal(read.doc.title, '论文大纲');
  assert.equal(read.slug, created.slug);
});

test('create 用模板生成结构', () => {
  const store = tempProject();
  const created = store.create({ title: '项目规划', template: 'project-roadmap' });
  assert.equal(created.template.id, 'project-roadmap');
  assert.ok(docStats(created.doc).nodes >= 8);
  assert.match(created.doc.journal[0].summary, /模板/);
  assert.throws(() => store.create({ title: 'x', template: 'nope' }), /未知模板/);
});

test('create 记录标签，list 带出标签并支持按标签过滤', () => {
  const store = tempProject();
  store.create({ title: '架构评审', tags: ['项目', '架构'] });
  store.create({ title: '读书笔记', tags: ['学习'] });
  store.create({ title: '无标签的图' });

  const list = store.list();
  assert.equal(list.length, 3);
  assert.deepEqual(list.find((map) => map.title === '架构评审').tags, ['项目', '架构']);
  assert.deepEqual(list.find((map) => map.title === '无标签的图').tags, []);

  const filtered = store.list({ tag: '项目' });
  assert.deepEqual(filtered.map((map) => map.title), ['架构评审']);
  assert.deepEqual(store.list({ tag: '架构' }).map((map) => map.title), ['架构评审'], '标签过滤忽略大小写之外的写法差异');
  assert.deepEqual(store.list({ tag: '并不存在的标签' }), []);

  const counts = store.tagCounts();
  assert.deepEqual(
    counts.map((item) => [item.tag, item.count]),
    [['项目', 1], ['架构', 1], ['学习', 1]].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
  assert.ok(store.summary().tags.length === 3, 'summary 里也带标签汇总');
});

test('标签通过 op 修改后写进 journal', () => {
  const store = tempProject();
  const { slug } = store.create({ title: 'a' });
  const { doc } = store.applyOps(slug, [{ op: 'setDoc', tags: ['论文', '待补'] }], { by: 'user' });
  assert.deepEqual(doc.tags, ['论文', '待补']);
  assert.match(doc.journal.at(-1).summary, /标签/);
  const reread = store.read(slug).doc;
  assert.deepEqual(reread.tags, ['论文', '待补'], '落盘后仍然是同一个标签列表');

  const cleared = store.applyOps(slug, [{ op: 'setDoc', tags: [] }], { by: 'user' }).doc;
  assert.deepEqual(cleared.tags, []);
  assert.match(cleared.journal.at(-1).summary, /清空标签/);
});

test('同名导图自动加序号', () => {
  const store = tempProject();
  const a = store.create({ title: '同名' });
  const b = store.create({ title: '同名' });
  assert.notEqual(a.slug, b.slug);
  assert.equal(b.slug, '同名-2');
});

test('save 递增 rev 并写 journal', () => {
  const store = tempProject();
  const { slug, doc } = store.create({ title: 'a' });
  const before = doc.rev;
  const next = structuredClone(doc);
  addNode(next, { parent: 'root', text: '新章节' });
  const saved = store.save(slug, next, { by: 'user' });
  assert.equal(saved.doc.rev, before + 1);
  assert.match(saved.doc.journal.at(-1).summary, /新增 1 个节点/);
  const again = store.read(slug);
  assert.equal(again.doc.nodes.length, 2);
});

test('save 的 baseRev 冲突保护', () => {
  const store = tempProject();
  const { slug, doc } = store.create({ title: 'b' });
  const stale = structuredClone(doc);
  store.save(slug, { ...doc, title: 'b2' }, { by: 'agent' });
  assert.throws(() => store.save(slug, stale, { baseRev: stale.rev }), (error) => error instanceof StoreError && error.code === 'conflict');
  const forced = store.save(slug, stale, { baseRev: stale.rev, force: true });
  assert.equal(forced.doc.title, 'b');
});

test('applyOps 串行化并保留历史快照', () => {
  const store = tempProject();
  const { slug } = store.create({ title: 'c' });
  store.applyOps(slug, [{ op: 'addNode', parent: 'root', text: 'A' }], { by: 'agent' });
  const { doc } = store.applyOps(slug, [{ op: 'addNode', parent: 'root', text: 'B' }], { by: 'agent' });
  assert.equal(doc.nodes.length, 3);
  assert.equal(doc.rev, 2, 'create 时 rev=0，两次写入后 rev=2');
  const history = store.history(slug);
  assert.ok(history.length >= 2);
  assert.equal(history[0].rev, doc.rev - 1, '最新历史应是当前版本的前一版');
});

test('changesSince 能看出人类改了什么', () => {
  const store = tempProject();
  const { slug } = store.create({ title: 'd' });
  const { doc } = store.applyOps(slug, [{ op: 'addNode', parent: 'root', text: 'AI 加的' }], { by: 'agent' });
  const nodeId = doc.nodes.find((node) => node.text === 'AI 加的').id;
  const revAfterAgent = doc.rev;
  store.applyOps(slug, [{ op: 'updateNode', id: nodeId, text: '人类改成这样' }], { by: 'user' });
  const changes = store.changesSince(slug, revAfterAgent);
  assert.equal(changes.journal.length, 1);
  assert.equal(changes.journal[0].by, 'user');
  const diff = changes.changedNodes.find((item) => item.id === nodeId);
  assert.ok(diff, '应能定位被改的节点');
  assert.equal(diff.to, '人类改成这样');
});

test('changesSince 在没有更早快照时用最老快照兜底', () => {
  const store = tempProject();
  const { slug } = store.create({ title: 'old' });
  store.applyOps(slug, [{ op: 'addNode', parent: 'root', text: '第一次' }], { by: 'agent' });
  const { doc } = store.applyOps(slug, [{ op: 'addNode', parent: 'root', text: '人类加的' }], { by: 'user' });
  // sinceRev=0 比最老快照还早：应退化为"以最老快照为基准"，并给出 baseRev
  const changes = store.changesSince(slug, 0);
  assert.equal(changes.rev, doc.rev);
  assert.equal(changes.baseRev, 0, '应以最老快照（rev 0）为基准');
  assert.ok(changes.changedNodes.length >= 1, '仍应给出节点级差异');
  // 正常区间不触发兜底
  const precise = store.changesSince(slug, doc.rev - 1);
  assert.equal(precise.baseRev, doc.rev - 1);
  assert.equal(precise.changedNodes.filter((item) => item.type === 'add').length, 1);
});

test('rollback 回到历史版本', () => {
  const store = tempProject();
  const { slug, doc } = store.create({ title: 'e' });
  const rev0 = doc.rev;
  store.applyOps(slug, [{ op: 'addNode', parent: 'root', text: 'X' }], { by: 'agent' });
  const rolled = store.rollback(slug, rev0, { by: 'user' });
  assert.ok(rolled.doc.rev > rev0);
  assert.equal(rolled.doc.nodes.length, 1);
  assert.match(rolled.doc.journal.at(-1).summary, /回滚/);
});

test('delete 删除文件与历史', () => {
  const store = tempProject();
  const { slug, file } = store.create({ title: 'f' });
  store.delete(slug);
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.list().length, 0);
  assert.throws(() => store.read(slug), /找不到导图/);
});

test('resolve 支持 slug / 文件名 / 标题 / 绝对路径', () => {
  const store = tempProject();
  const created = store.create({ title: '示例 导图' });
  assert.equal(store.read(created.slug).slug, created.slug);
  assert.equal(store.read(`${created.slug}${MAP_EXT}`).slug, created.slug);
  assert.equal(store.read('示例 导图').slug, created.slug);
  assert.equal(store.read(created.file).slug, created.slug);
  assert.throws(() => store.read('不存在'), /找不到导图/);
});

test('saveConfig 记住自定义导图目录', () => {
  const store = tempProject();
  const custom = path.join(store.projectDir, 'custom-maps');
  store.saveConfig({ mapsDir: 'custom-maps' });
  assert.equal(store.mapsDir, custom);
  assert.ok(fs.existsSync(custom));
  const raw = JSON.parse(fs.readFileSync(store.configPath, 'utf8'));
  assert.equal(raw.mapsDir, 'custom-maps');
  // 重新打开仍然是同一目录
  const reopened = new Store({ projectDir: store.projectDir });
  assert.equal(reopened.mapsDir, custom);
  // 绝对路径也支持
  const absolute = fs.mkdtempSync(path.join(os.tmpdir(), 'mindleaf-abs-'));
  reopened.saveConfig({ mapsDir: absolute });
  assert.equal(reopened.mapsDir, absolute);
});

test('workspaceDir 决定相对文件链接的根', () => {
  const store = tempProject();
  assert.equal(store.workspaceDir, store.projectDir);
  store.saveConfig({ workspaceDir: '..' });
  assert.equal(store.workspaceDir, path.dirname(store.projectDir));
});

test('summary 给网页/CLI 用的信息齐全', () => {
  const store = tempProject();
  store.create({ title: 'g' });
  const summary = store.summary();
  assert.equal(summary.projectDir, store.projectDir);
  assert.ok(summary.mapsDir.includes('maps'));
  assert.equal(summary.maps.length, 1);
  assert.equal(summary.workspaceDir, store.projectDir);
});

test('订阅能收到写入事件', () => {
  const store = tempProject();
  const events = [];
  const off = store.subscribe((event) => events.push(event));
  const { slug } = store.create({ title: 'h' });
  store.applyOps(slug, [{ op: 'addNode', parent: 'root', text: 'x' }], { by: 'agent' });
  off();
  store.applyOps(slug, [{ op: 'addNode', parent: 'root', text: 'y' }], { by: 'agent' });
  assert.ok(events.some((event) => event.type === 'create'));
  assert.ok(events.some((event) => event.type === 'ops'));
  assert.equal(events.filter((event) => event.type === 'ops').length, 1);
});

test('损坏的导图文件不会让 list 崩', () => {
  const store = tempProject();
  fs.writeFileSync(path.join(store.mapsDir, 'broken.mindmap.json'), '{ this is not json', 'utf8');
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].broken, true);
  assert.throws(() => store.read('broken'), /解析失败/);
});

test('findProjectRoot 向上查找', () => {
  const store = tempProject();
  const deep = path.join(store.projectDir, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findProjectRoot(deep), store.projectDir);
  assert.equal(findProjectRoot(os.tmpdir()), null);
});

test('模板清单完整且都能解析', () => {
  const templates = listTemplates({ force: true });
  assert.ok(templates.length >= 8);
  for (const template of templates) {
    assert.ok(template.id);
    assert.ok(template.title);
    assert.ok(template.nodes >= 2, `${template.id} 节点太少`);
    assert.ok(template.markdown.startsWith('# '), `${template.id} 应以一级标题开头`);
  }
  const thesis = getTemplate('thesis-outline');
  assert.equal(thesis.title, '论文提纲');
  const built = docFromTemplate('thesis-outline', { title: '自定义标题' });
  assert.equal(built.doc.title, '自定义标题');
  assert.equal(built.doc.nodes[0].text, '自定义标题');
  assert.equal(getTemplate('nope'), null);
});

test('diffNodes 覆盖增删改移', () => {
  const store = tempProject();
  const { slug, doc } = store.create({ title: 'i' });
  const before = structuredClone(doc);
  const { doc: after } = store.applyOps(
    slug,
    [
      { op: 'addNode', parent: 'root', text: '新' },
      { op: 'setDoc', title: '改名' },
    ],
    { by: 'agent' },
  );
  const changes = diffNodes(before, after);
  assert.ok(changes.some((change) => change.type === 'add'));
});
