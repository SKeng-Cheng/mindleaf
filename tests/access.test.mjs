import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accessEntries, formatAccessEntries, isAllInterfaces, primaryLanAddress, randomToken, resolveToken } from '../src/server/access.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mindleaf-access-'));

test('accessEntries：本人入口固定回环，协作入口用局域网地址', () => {
  const both = accessEntries({ port: 7788, listenHost: '0.0.0.0', token: 'k3f9x2' });
  assert.match(both.local, /^http:\/\/127\.0\.0\.1:7788\/\?t=k3f9x2$/);
  if (primaryLanAddress()) {
    assert.ok(both.lan, '有局域网地址时应给出协作入口');
    assert.match(both.lan, /^http:\/\/\d+\.\d+\.\d+\.\d+:7788\/\?t=k3f9x2$/);
    assert.notEqual(both.lan, both.local);
    assert.equal(both.same, false);
  } else {
    assert.equal(both.lan, null);
    assert.equal(both.same, true, '没有局域网时两个入口相同');
  }

  // 只监听本机：没有协作入口
  const localOnly = accessEntries({ port: 7788, listenHost: '127.0.0.1', token: 'k3f9x2' });
  assert.equal(localOnly.lan, null);
  assert.equal(localOnly.same, true);

  // 没口令时不带 ?t=
  const open = accessEntries({ port: 7788, listenHost: '0.0.0.0', token: '' });
  assert.match(open.local, /^http:\/\/127\.0\.0\.1:7788\/$/);

  // 指定导图时带 hash
  const withMap = accessEntries({ port: 7788, listenHost: '127.0.0.1', token: 'x', map: '我的图' });
  assert.match(withMap.local, /#%E6%88%91%E7%9A%84%E5%9B%BE$/);
});

test('formatAccessEntries：两入口时打两行，相同时只打一行', () => {
  const two = formatAccessEntries(accessEntries({ port: 7788, listenHost: '127.0.0.1', token: 'abc' }), {});
  assert.equal(two.length, 1, '只监听本机时只打一行');
  assert.match(two[0], /打开/);
  assert.doesNotMatch(two[0], /发给对方/);

  const both = formatAccessEntries({ local: 'http://127.0.0.1:1/?t=a', lan: 'http://10.0.0.2:1/?t=a', same: false }, {});
  assert.equal(both.length, 2);
  assert.match(both[0], /本人打开/);
  assert.match(both[1], /发给对方/);
});

test('isAllInterfaces 认得 0.0.0.0 和 ::', () => {
  assert.equal(isAllInterfaces('0.0.0.0'), true);
  assert.equal(isAllInterfaces('::'), true);
  assert.equal(isAllInterfaces(''), true);
  assert.equal(isAllInterfaces('127.0.0.1'), false);
});

test('口令：自动生成、记住、可显式覆盖、可关掉', () => {
  const dir = tempDir();
  const auto = resolveToken(dir, {});
  assert.ok(auto.length >= 6, `自动口令应该够长，实际 ${auto}`);
  assert.equal(resolveToken(dir, {}), auto, '第二次启动应沿用同一个口令（发给对方的地址不会变）');
  assert.ok(fs.existsSync(path.join(dir, '.mindleaf', 'token')), '口令应落盘');

  const explicit = resolveToken(dir, { token: 'my-token' });
  assert.equal(explicit, 'my-token');
  assert.equal(resolveToken(dir, {}), 'my-token', '显式指定的口令也要记住');

  assert.equal(resolveToken(dir, { noToken: true }), '', '--no-token 时不设口令');

  // 每次随机的口令不重复
  assert.notEqual(randomToken(), randomToken());
  assert.match(randomToken(), /^[A-Za-z0-9_-]{8}$/);
});
