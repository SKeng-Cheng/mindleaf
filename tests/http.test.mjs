import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/http.mjs';
import { CONFIG_FILE, MAP_EXT } from '../src/server/store.mjs';

const tempProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindleaf-http-'));
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify({ version: 1, mapsDir: 'maps' }), 'utf8');
  return dir;
};

const setup = async () => {
  const projectDir = tempProject();
  const session = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
  const base = session.url;
  const api = async (method, pathname, body) => {
    const response = await fetch(base + pathname, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      return { status: response.status, json: await response.json(), response };
    }
    return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()), response };
  };
  return { session, base, api, projectDir };
};

test('HTTP: 设了口令后，没口令一律 401，带口令（网址/cookie/请求头）才放行', async (t) => {
  const projectDir = tempProject();
  const session = await startServer({ projectDir, port: 0, host: '127.0.0.1', token: 'abc123' });
  t.after(() => session.close());

  // 没口令
  const bare = await fetch(`${session.url}/`);
  assert.equal(bare.status, 401, '没口令打开页面应 401');
  const bareText = await bare.text();
  assert.match(bareText, /访问口令/, '应给出提示页面');
  assert.match(bareText, /<form/, '页面上应有输入口令的表单');
  assert.equal((await fetch(`${session.url}/api/state`)).status, 401, '接口没口令也应 401');

  // 错口令
  assert.equal((await fetch(`${session.url}/?t=wrong`)).status, 401);
  assert.equal((await fetch(`${session.url}/api/state?t=wrong`)).status, 401);

  // 正确口令（网址）+ 种 cookie
  const ok = await fetch(`${session.url}/?t=abc123`);
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie') ?? '';
  assert.match(cookie, /mindleaf_token=abc123/, `应种下 cookie，实际 ${cookie}`);
  assert.match(cookie, /HttpOnly/, 'cookie 应是 HttpOnly');
  assert.match(cookie, /SameSite=Lax/, 'cookie 应是 SameSite=Lax');

  // 之后用 cookie 访问接口（前端不用改代码）
  const viaCookie = await fetch(`${session.url}/api/state`, { headers: { cookie: 'mindleaf_token=abc123' } });
  assert.equal(viaCookie.status, 200);
  assert.ok((await viaCookie.json()).maps, '应返回状态');

  // 请求头方式（给 CLI / 脚本用）
  const viaHeader = await fetch(`${session.url}/api/state`, { headers: { 'x-mindleaf-token': 'abc123' } });
  assert.equal(viaHeader.status, 200);

  // 健康检查始终放行（用来判断服务是否起来）
  assert.equal((await fetch(`${session.url}/api/health`)).status, 200);

  // shareUrl 带上口令
  assert.match(session.shareUrl, /\?t=abc123/);
  assert.equal(session.token, 'abc123');
});

test('HTTP: 没设口令时一切照旧可访问', async (t) => {
  const { session, api } = await setup();
  t.after(() => session.close());
  assert.equal((await api('GET', '/api/state')).status, 200);
  assert.equal(session.shareUrl, session.url, '没口令时分享地址就是普通地址');
});

test('HTTP: 最后一个页面关掉后服务自动退出', async (t) => {
  const projectDir = tempProject();
  const session = await startServer({ projectDir, port: 0, host: '127.0.0.1', idleExitMs: 250 });
  t.after(() => session.close().catch(() => {}));
  assert.equal(session.clientCount(), 0);

  // 模拟一个网页：连上 SSE
  const response = await fetch(`${session.url}/api/events`);
  const reader = response.body.getReader();
  await reader.read(); // ": connected"
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(session.clientCount(), 1, '页面连上后应有 1 个客户端');

  // 页面还开着时不应该退出
  assert.equal(await Promise.race([session.exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('alive'), 400))]), 'alive');

  // 关掉页面（断开 SSE）→ 应在 idleExitMs 后退出
  await reader.cancel();
  const started = Date.now();
  await session.exited;
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 200, `应等 idleExitMs 再退出，实际 ${elapsed}ms`);
  assert.ok(elapsed < 2000, `不应拖太久，实际 ${elapsed}ms`);
});

test('HTTP: 一直没人打开页面时也会超时退出', async (t) => {
  const projectDir = tempProject();
  const session = await startServer({ projectDir, port: 0, host: '127.0.0.1', firstPageTimeoutMs: 250 });
  t.after(() => session.close().catch(() => {}));
  const started = Date.now();
  await session.exited;
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 200 && elapsed < 2000, `应在 firstPageTimeoutMs 附近退出，实际 ${elapsed}ms`);
});

test('HTTP: /api/shutdown 能关掉服务', async (t) => {
  const projectDir = tempProject();
  const session = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
  t.after(() => session.close().catch(() => {}));
  const response = await fetch(`${session.url}/api/shutdown`, { method: 'POST' });
  assert.equal(response.status, 200);
  await session.exited;
  assert.ok(true, '服务已退出');
});

test('HTTP: 状态/模板/健康检查', async (t) => {
  const { session, api } = await setup();
  t.after(() => session.close());
  const health = await api('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  const state = await api('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.maps.length, 0);
  assert.ok(state.json.mapsDir.endsWith('maps'));
  assert.equal(typeof state.json.engines.png, 'boolean');
  assert.ok(state.json.formats.includes('pdf'));
  const templates = await api('GET', '/api/templates');
  assert.ok(templates.json.templates.length >= 8);
  const one = await api('GET', '/api/templates/thesis-outline');
  assert.match(one.json.template.markdown, /第 1 章/);
  const missing = await api('GET', '/api/templates/nope');
  assert.equal(missing.status, 404);
});

test('HTTP: 新建（含模板）→ 读取 → ops → 导出', async (t) => {
  const { session, api } = await setup();
  t.after(() => session.close());
  const created = await api('POST', '/api/maps', { title: '论文', template: 'thesis-outline' });
  assert.equal(created.status, 201);
  const slug = created.json.slug;
  assert.ok(created.json.doc.nodes.length > 20);
  const slugPath = encodeURIComponent(slug);

  const read = await api('GET', `/api/maps/${slugPath}`);
  assert.equal(read.status, 200);
  assert.match(read.json.outline, /〔root〕/);
  assert.ok(read.json.markdown.startsWith('# '));

  const ops = await api('POST', `/api/maps/${slugPath}/ops`, {
    ops: [
      { op: 'addNode', parent: 'root', text: '第 7 章 新增' },
      { op: 'updateNode', id: read.json.doc.nodes[0].id, note: '人工备注' },
    ],
    by: 'test',
  });
  assert.equal(ops.status, 200);
  assert.equal(ops.json.results.length, 2);
  assert.ok(ops.json.doc.rev > read.json.doc.rev);

  const svg = await api('POST', `/api/maps/${slugPath}/export`, { format: 'svg' });
  assert.equal(svg.status, 200);
  assert.match(svg.buffer.toString('utf8'), /^<svg/);
  assert.match(svg.response.headers.get('content-disposition') ?? '', /attachment/);

  const list = await api('GET', '/api/maps');
  assert.equal(list.json.maps.length, 1);
  assert.equal(list.json.maps[0].slug, slug);
});

test('HTTP: 标签接口 —— 新建带标签、/api/tags、按标签过滤', async (t) => {
  const { session, api } = await setup();
  t.after(() => session.close());
  await api('POST', '/api/maps', { title: '架构评审', tags: ['项目', '架构'] });
  await api('POST', '/api/maps', { title: '读书笔记', tags: ['学习'] });
  await api('POST', '/api/maps', { title: '随笔' });

  const tags = await api('GET', '/api/tags');
  assert.equal(tags.status, 200);
  const names = tags.json.tags.map((item) => item.tag);
  assert.deepEqual(names.sort(), ['学习', '架构', '项目']);

  const filtered = await api('GET', `/api/maps?tag=${encodeURIComponent('项目')}`);
  assert.deepEqual(filtered.json.maps.map((map) => map.title), ['架构评审']);

  const all = await api('GET', '/api/maps');
  assert.equal(all.json.maps.length, 3);
  assert.deepEqual(all.json.maps.find((map) => map.title === '随笔').tags, []);

  // 通过 ops 改标签
  const slugPath = encodeURIComponent('架构评审');
  const updated = await api('POST', `/api/maps/${slugPath}/ops`, { ops: [{ op: 'setDoc', tags: ['架构'] }], by: 'user' });
  assert.deepEqual(updated.json.doc.tags, ['架构']);
  const after = await api('GET', '/api/tags');
  assert.equal(after.json.tags.find((item) => item.tag === '项目'), undefined, '没有图用的标签应消失');
});

test('HTTP: PUT 整份保存与 409 冲突', async (t) => {
  const { session, api } = await setup();
  t.after(() => session.close());
  const created = await api('POST', '/api/maps', { title: 'c' });
  const slugPath = encodeURIComponent(created.json.slug);
  const doc = created.json.doc;
  doc.title = '改名后';
  const saved = await api('PUT', `/api/maps/${slugPath}`, { doc, baseRev: doc.rev });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.doc.title, '改名后');
  const conflict = await api('PUT', `/api/maps/${slugPath}`, { doc, baseRev: doc.rev });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, 'conflict');
  assert.ok(conflict.json.current);
});

test('HTTP: Markdown 导入、文件预览、配置、删除', async (t) => {
  const { session, api, projectDir } = await setup();
  t.after(() => session.close());
  fs.writeFileSync(path.join(projectDir, 'note.md'), '# 外部文件\n\n## 小节\n', 'utf8');
  const imported = await api('POST', '/api/maps/new/import', { markdown: '# 导入的图\n\n## A\n\n### A1\n', title: '导入' });
  assert.equal(imported.status, 200);
  assert.equal(imported.json.doc.title, '导入');
  assert.ok(imported.json.doc.nodes.length >= 3);

  const file = await api('GET', `/api/file?path=${encodeURIComponent('note.md')}`);
  assert.equal(file.status, 200);
  assert.equal(file.json.kind, 'text');
  assert.match(file.json.content, /外部文件/);
  const missing = await api('GET', '/api/file?path=nope.md');
  assert.equal(missing.status, 404);

  const deleted = await api('DELETE', `/api/maps/${encodeURIComponent(imported.json.slug)}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.deleted, true);

  // 改导图目录后，原来的图不在新目录里了（目录切换是"换一个库"的语义）
  const config = await api('PUT', '/api/config', { mapsDir: 'my-maps' });
  assert.equal(config.status, 200);
  assert.ok(config.json.summary.mapsDir.endsWith('my-maps'));
  assert.ok(fs.existsSync(path.join(projectDir, 'my-maps')));
});

test('HTTP: 历史与回滚接口', async (t) => {
  const { session, api } = await setup();
  t.after(() => session.close());
  const created = await api('POST', '/api/maps', { title: 'h' });
  const slugPath = encodeURIComponent(created.json.slug);
  await api('POST', `/api/maps/${slugPath}/ops`, { ops: [{ op: 'addNode', parent: 'root', text: 'A' }] });
  const history = await api('GET', `/api/maps/${slugPath}/history`);
  assert.ok(history.json.history.length >= 1);
  const rev = history.json.history[0].rev;
  const rolled = await api('POST', `/api/maps/${slugPath}/rollback`, { rev });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.json.doc.nodes.length, 1);
  const changes = await api('GET', `/api/maps/${slugPath}/changes?since=0`);
  assert.ok(changes.json.journal.length >= 1);
});

test('HTTP: 静态页面与核心模块可访问，路径穿越被拒绝', async (t) => {
  const { session, base } = await setup();
  t.after(() => session.close());
  const page = await fetch(base + '/');
  const html = await page.text();
  assert.match(html, /<html/i);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);

  const core = await fetch(base + '/src/core/index.mjs');
  assert.equal(core.status, 200);
  assert.match(await core.text(), /export \*/);

  const traversal = await fetch(base + '/../package.json');
  assert.notEqual(traversal.status, 200);
});

test('HTTP: 未知接口返回 JSON 错误', async (t) => {
  const { session, api } = await setup();
  t.after(() => session.close());
  const result = await api('GET', '/api/nope');
  assert.equal(result.status, 404);
  assert.equal(result.json.error, 'not_found');
  const empty = await api('POST', '/api/maps', {});
  assert.equal(empty.status, 201, '不传标题时用默认标题建图');
  assert.equal(empty.json.doc.title, '未命名导图');
  const invalid = await api('POST', '/api/maps', { template: 'no-such-template' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, 'invalid_argument');
});

test('HTTP: 事件流能收到写入通知', async (t) => {
  const { session, base, api } = await setup();
  t.after(() => session.close());
  const controller = new AbortController();
  const response = await fetch(base + '/api/events', { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const created = await api('POST', '/api/maps', { title: 'e' });
  await api('POST', `/api/maps/${encodeURIComponent(created.json.slug)}/ops`, { ops: [{ op: 'addNode', parent: 'root', text: 'x' }] });
  let text = '';
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !text.includes('"type":"ops"')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();
  assert.match(text, /"type":"create"/);
  assert.match(text, /"type":"ops"/);
});

test('HTTP: 导图文件落盘为 .mindmap.json', async (t) => {
  const { session, api, projectDir } = await setup();
  t.after(() => session.close());
  await api('POST', '/api/maps', { title: '磁盘上的图' });
  const files = fs.readdirSync(path.join(projectDir, 'maps')).filter((name) => name.endsWith(MAP_EXT));
  assert.equal(files.length, 1);
  assert.equal(files[0], '磁盘上的图.mindmap.json');
});
