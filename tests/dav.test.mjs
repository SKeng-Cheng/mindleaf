import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../src/server/http.mjs';
import { CONFIG_FILE } from '../src/server/store.mjs';

const TOKEN = 'davpass';
/** Basic 认证头。 */
const authFor = (session) => `Basic ${Buffer.from(`mindleaf:${TOKEN}`).toString('base64')}`;

const setup = async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindleaf-dav-'));
  fs.writeFileSync(path.join(projectDir, CONFIG_FILE), JSON.stringify({ version: 1, mapsDir: 'maps', workspaceDir: '.' }), 'utf8');
  fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'docs', '方案.md'), '# 方案\n第一版\n', 'utf8');
  fs.writeFileSync(path.join(projectDir, 'docs', '图.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  const session = await startServer({ projectDir, port: 0, host: '127.0.0.1', token: TOKEN });
  const { slug } = session.store.create({ title: '网盘', rootText: '根' });
  session.store.applyOps(slug, [
    { op: 'addSharedFile', path: 'docs/方案.md', mode: 'rw' },
    { op: 'addSharedFile', path: 'docs/图.png', mode: 'ro' },
  ], { by: 'user' });
  const auth = `Basic ${Buffer.from(`mindleaf:${TOKEN}`).toString('base64')}`;
  const call = (method, urlPath, { headers = {}, body } = {}) =>
    fetch(`${session.url}${urlPath}`, { method, headers: { authorization: auth, ...headers }, body });
  return { session, call, projectDir, auth };
};

test('WebDAV: 没口令 401，口令对了能 OPTIONS/PROPFIND', async (t) => {
  const { session, auth } = await setup();
  t.after(() => session.close());

  const noAuth = await fetch(`${session.url}/dav/`, { method: 'PROPFIND' });
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get('www-authenticate') ?? '', /Basic/);

  const options = await fetch(`${session.url}/dav/`, { method: 'OPTIONS', headers: { authorization: auth } });
  assert.equal(options.status, 200);
  assert.match(options.headers.get('dav') ?? '', /1/);

  const propfind = await fetch(`${session.url}/dav/`, { method: 'PROPFIND', headers: { authorization: auth, depth: '1' } });
  assert.equal(propfind.status, 207);
  const xml = await propfind.text();
  assert.match(xml, /<D:multistatus/);
  assert.match(xml, /\/dav\/docs\//, '根目录下应能看到 docs 目录');

  const sub = await fetch(`${session.url}/dav/docs/`, { method: 'PROPFIND', headers: { authorization: auth, depth: '1' } });
  const subXml = await sub.text();
  assert.match(subXml, /方案\.md/);
  assert.match(subXml, /图\.png/);
});

test('WebDAV: 能读、能写 rw 文件，只读文件拒绝，清单外 404', async (t) => {
  const { session, call, projectDir } = await setup();
  t.after(() => session.close());

  const md = `/dav/docs/${encodeURIComponent('方案.md')}`;
  const get = await call('GET', md);
  assert.equal(get.status, 200);
  assert.match(await get.text(), /第一版/);

  const put = await call('PUT', md, { body: Buffer.from('# 方案\n第二版（网盘改的）\n') });
  assert.equal(put.status, 204);
  assert.equal(fs.readFileSync(path.join(projectDir, 'docs/方案.md'), 'utf8'), '# 方案\n第二版（网盘改的）\n');

  const ro = await call('PUT', `/dav/docs/${encodeURIComponent('图.png')}`, { body: Buffer.from('x') });
  assert.equal(ro.status, 403, '只读分享不能写');

  assert.equal((await call('GET', '/dav/mindleaf.json')).status, 404, '清单外的文件不可见');
  // 用原始 http 请求发一个"精确控制"的路径：fetch/URL 会把 %2e%2e 规范化掉，测不到服务端
  const rawStatus = await new Promise((resolve, reject) => {
    const url = new URL(session.url);
    const req = http.request(
      { host: url.hostname, port: url.port, path: '/dav/a/%2e%2e/%2e%2e/etc/passwd', method: 'GET', headers: { authorization: authFor(session) } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(rawStatus, 403, '路径穿越被拒');

  // LOCK / UNLOCK 让 Office 的保存流程能走通
  const lock = await call('LOCK', md);
  assert.equal(lock.status, 200);
  assert.match(lock.headers.get('lock-token') ?? '', /opaquelocktoken:/);
  assert.equal((await call('UNLOCK', md, { headers: { 'lock-token': '<opaquelocktoken:x>' } })).status, 204);

  // 删除 / 新建目录不允许
  assert.equal((await call('DELETE', md)).status, 405);
  assert.equal((await call('MKCOL', '/dav/new/')).status, 405);
});

test('WebDAV: 同一文件被两张图分享时，只要有一处 rw 就可写', async (t) => {
  const { session, call } = await setup();
  t.after(() => session.close());
  const second = session.store.create({ title: '第二张', rootText: '根' });
  session.store.applyOps(second.slug, [{ op: 'addSharedFile', path: 'docs/图.png', mode: 'rw' }], { by: 'user' });
  const put = await call('PUT', `/dav/docs/${encodeURIComponent('图.png')}`, { body: Buffer.from('png-data') });
  assert.equal(put.status, 204);
});

test('WebDAV: 路径解析挡住穿越', async () => {
  const { davRelativePath } = await import('../src/server/dav.mjs');
  assert.equal(davRelativePath('/dav/docs/a.docx'), 'docs/a.docx');
  assert.equal(davRelativePath('/dav/'), '');
  assert.equal(davRelativePath('/dav/docs/%E6%96%B9%E6%A1%88.md'), 'docs/方案.md');
  assert.equal(davRelativePath('/dav/../secret'), null);
  assert.equal(davRelativePath('/dav/a/../../secret'), null);
});
