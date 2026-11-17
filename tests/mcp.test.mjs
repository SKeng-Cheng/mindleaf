import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from '../src/server/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'mindleaf.mjs');

/** 起一个 MCP 子进程，按行收发 JSON-RPC。 */
async function startMcp(projectDir) {
  const child = spawn(process.execPath, [BIN, 'mcp', '--project', projectDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MINDLEAF_DEBUG: '' },
  });
  const pending = new Map();
  const notifications = [];
  const stderr = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else {
        notifications.push(message);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1;
      const requestId = id;
      const timer = setTimeout(() => reject(new Error(`MCP 请求超时: ${method}（stderr: ${stderr.join('').slice(-400)}）`)), 15000);
      pending.set(requestId, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method} 失败: ${message.error.message}`));
        else resolve(message.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const callTool = async (name, args = {}) => {
    const result = await request('tools/call', { name, arguments: args });
    return { text: result.content?.[0]?.text ?? '', isError: result.isError === true, raw: result };
  };
  const close = () =>
    new Promise((resolve) => {
      child.on('exit', resolve);
      child.stdin.end();
    });
  return { child, request, notify, callTool, close, stderr, notifications };
}

const tempProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindleaf-mcp-'));
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify({ version: 1, mapsDir: 'maps' }), 'utf8');
  return dir;
};

test('MCP: initialize 握手与协议版本协商', async (t) => {
  const projectDir = tempProject();
  const mcp = await startMcp(projectDir);
  t.after(() => mcp.close());
  const init = await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.1' },
  });
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.equal(init.serverInfo.name, 'mindleaf');
  assert.ok(init.instructions.length > 50);
  assert.equal(init.capabilities.tools.listChanged, false);
  mcp.notify('notifications/initialized');
  const pong = await mcp.request('ping');
  assert.deepEqual(pong, {});

  // 老客户端请求旧协议版本时跟随客户端
  const second = await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old', version: '1' } });
  assert.equal(second.protocolVersion, '2024-11-05');
});

test('MCP: tools/list 暴露完整工具集与合法 schema', async (t) => {
  const projectDir = tempProject();
  const mcp = await startMcp(projectDir);
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const { tools } = await mcp.request('tools/list');
  const names = tools.map((tool) => tool.name);
  for (const required of [
    'mindleaf_list_maps',
    'mindleaf_list_templates',
    'mindleaf_create_map',
    'mindleaf_read_map',
    'mindleaf_add_node',
    'mindleaf_update_node',
    'mindleaf_remove_node',
    'mindleaf_move_node',
    'mindleaf_apply_ops',
    'mindleaf_add_edge',
    'mindleaf_update_map',
    'mindleaf_export_map',
    'mindleaf_import_markdown',
    'mindleaf_recent_changes',
    'mindleaf_open_in_browser',
    'mindleaf_doctor',
  ]) {
    assert.ok(names.includes(required), `缺少工具 ${required}`);
  }
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 10, `${tool.name} 缺少描述`);
  }
});

test('MCP: 建图 → 加节点 → 读图 → 改 → 删 → 关联线', async (t) => {
  const projectDir = tempProject();
  const mcp = await startMcp(projectDir);
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });

  const created = await mcp.callTool('mindleaf_create_map', { title: '测试图', rootText: '根' });
  assert.match(created.text, /已创建导图/);
  assert.equal(created.isError, false);

  const added = await mcp.callTool('mindleaf_add_node', { map: '测试图', text: '第一章', note: '说明' });
  assert.match(added.text, /已新增节点/);
  const parentId = /〔(n_[a-z0-9]+)〕/.exec(added.text)?.[1];
  assert.ok(parentId);

  const child = await mcp.callTool('mindleaf_add_node', { map: '测试图', parent: '第一章', text: '1.1 小节' });
  assert.match(child.text, /1\.1 小节/);

  const read = await mcp.callTool('mindleaf_read_map', { map: '测试图' });
  assert.match(read.text, /第一章/);
  assert.match(read.text, /1\.1 小节/);

  const json = await mcp.callTool('mindleaf_read_map', { map: '测试图', format: 'json' });
  const parsed = JSON.parse(json.text.slice(json.text.indexOf('{')));
  assert.equal(parsed.nodes.length, 3);

  const updated = await mcp.callTool('mindleaf_update_node', { map: '测试图', id: '第一章', text: '第 1 章' });
  assert.match(updated.text, /第 1 章/);

  const edge = await mcp.callTool('mindleaf_add_edge', { map: '测试图', from: '第 1 章', to: '1.1 小节', label: '包含' });
  assert.match(edge.text, /关联线/);

  const moved = await mcp.callTool('mindleaf_move_node', { map: '测试图', id: '1.1 小节', parent: 'root' });
  assert.match(moved.text, /已移动/);

  const ops = await mcp.callTool('mindleaf_apply_ops', {
    map: '测试图',
    ops: [
      { op: 'addNode', parent: 'root', text: '第二章' },
      { op: 'addNode', parent: 'root', text: '第三章' },
    ],
  });
  assert.match(ops.text, /2 个操作已应用/);

  const mapUpdate = await mcp.callTool('mindleaf_update_map', { map: '测试图', title: '改名图', layout: 'both' });
  assert.match(mapUpdate.text, /layout=both/);

  const removed = await mcp.callTool('mindleaf_remove_node', { map: '改名图', id: '第三章' });
  assert.match(removed.text, /已删除/);

  const changes = await mcp.callTool('mindleaf_recent_changes', { map: '改名图', sinceRev: 0 });
  assert.match(changes.text, /rev/);
});

test('MCP: 模板、导出、Markdown 导入、doctor', async (t) => {
  const projectDir = tempProject();
  const mcp = await startMcp(projectDir);
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });

  const templates = await mcp.callTool('mindleaf_list_templates');
  assert.match(templates.text, /thesis-outline/);

  const created = await mcp.callTool('mindleaf_create_map', { title: '论文模板', template: 'thesis-outline' });
  assert.match(created.text, /模板/);

  const imported = await mcp.callTool('mindleaf_import_markdown', {
    map: 'new',
    markdown: '# 导入图\n\n## A\n\n- 备注\n\n## B\n',
  });
  assert.match(imported.text, /已从 Markdown 新建导图/);

  const exported = await mcp.callTool('mindleaf_export_map', { map: '论文模板', format: 'svg' });
  assert.match(exported.text, /已导出/);
  const exportedPath = exported.text.split('\n')[1]?.trim();
  assert.ok(fs.existsSync(exportedPath), `导出的文件应存在: ${exportedPath}`);

  const doctor = await mcp.callTool('mindleaf_doctor');
  assert.match(doctor.text, /项目目录/);

  const list = await mcp.callTool('mindleaf_list_maps');
  assert.match(list.text, /论文模板/);
});

test('MCP: 节点三种颜色，subtree 可以整枝改', async (t) => {
  const projectDir = tempProject();
  const mcp = await startMcp(projectDir);
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });

  await mcp.callTool('mindleaf_create_map', { title: '颜色图', rootText: '根' });
  const branch = await mcp.callTool('mindleaf_add_node', { map: '颜色图', text: '分支' });
  const branchId = /〔(n_[a-z0-9]+)〕/.exec(branch.text)?.[1];
  assert.ok(branchId);
  const child = await mcp.callTool('mindleaf_add_node', { map: '颜色图', parent: '分支', text: '子节点' });
  const childId = /〔(n_[a-z0-9]+)〕/.exec(child.text)?.[1];

  // 单节点：三种颜色
  const styled = await mcp.callTool('mindleaf_update_node', {
    map: '颜色图',
    id: branchId,
    color: '#fecdd3',
    textColor: '#b91c1c',
    lineColor: '#0ea5e9',
  });
  assert.equal(styled.isError, false, styled.text);
  let doc = JSON.parse((await mcp.callTool('mindleaf_read_map', { map: '颜色图', format: 'json' })).text.slice(
    (await mcp.callTool('mindleaf_read_map', { map: '颜色图', format: 'json' })).text.indexOf('{'),
  ));
  let node = doc.nodes.find((item) => item.id === branchId);
  assert.deepEqual(
    { color: node.color, textColor: node.textColor, lineColor: node.lineColor },
    { color: '#fecdd3', textColor: '#b91c1c', lineColor: '#0ea5e9' },
  );

  // 子树：连同子节点一起换底色
  await mcp.callTool('mindleaf_update_node', { map: '颜色图', id: branchId, color: '#bbf7d0', subtree: true });
  doc = JSON.parse(
    (await mcp.callTool('mindleaf_read_map', { map: '颜色图', format: 'json' })).text.replace(/^[^{]*/, ''),
  );
  assert.equal(doc.nodes.find((item) => item.id === branchId).color, '#bbf7d0');
  assert.equal(doc.nodes.find((item) => item.id === childId).color, '#bbf7d0', '子节点也应被染色');

  // 子树模式不许混别的字段
  const mixed = await mcp.callTool('mindleaf_update_node', {
    map: '颜色图',
    id: branchId,
    subtree: true,
    text: '改名',
    color: '#ffffff',
  });
  assert.equal(mixed.isError, true);
  assert.match(mixed.text, /只能改颜色/);
});

test('MCP: 字号、字体、框尺寸与 list_fonts', async (t) => {
  const projectDir = tempProject();
  const mcp = await startMcp(projectDir);
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  await mcp.callTool('mindleaf_create_map', { title: '排版图', rootText: '根' });
  const branch = await mcp.callTool('mindleaf_add_node', { map: '排版图', text: '分支' });
  const branchId = /〔(n_[a-z0-9]+)〕/.exec(branch.text)?.[1];

  const fonts = await mcp.callTool('mindleaf_list_fonts');
  assert.match(fonts.text, /kai/);
  assert.match(fonts.text, /楷体/);

  const styled = await mcp.callTool('mindleaf_update_node', {
    map: '排版图',
    id: branchId,
    fontSize: 22,
    font: 'kai',
    boxWidth: 220,
    boxHeight: 90,
  });
  assert.equal(styled.isError, false, styled.text);
  const read = await mcp.callTool('mindleaf_read_map', { map: '排版图', format: 'json' });
  const doc = JSON.parse(read.text.slice(read.text.indexOf('{')));
  const node = doc.nodes.find((item) => item.id === branchId);
  assert.deepEqual(
    { fontSize: node.fontSize, font: node.font, boxWidth: node.boxWidth, boxHeight: node.boxHeight },
    { fontSize: 22, font: 'kai', boxWidth: 220, boxHeight: 90 },
  );

  // 子树只能套字号/字体，不能套框尺寸
  const subtreeSizes = await mcp.callTool('mindleaf_update_node', { map: '排版图', id: branchId, subtree: true, fontSize: 16, font: 'song' });
  assert.equal(subtreeSizes.isError, false, subtreeSizes.text);
  const blocked = await mcp.callTool('mindleaf_update_node', { map: '排版图', id: branchId, subtree: true, boxWidth: 120 });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /只能改颜色/);
});

test('MCP: 关联线可以改说明/颜色/备注/批注、能列出、能删', async (t) => {
  const projectDir = tempProject();
  const mcp = await startMcp(projectDir);
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });

  await mcp.callTool('mindleaf_create_map', { title: '关联图', rootText: '根' });
  await mcp.callTool('mindleaf_add_node', { map: '关联图', text: 'A' });
  await mcp.callTool('mindleaf_add_node', { map: '关联图', text: 'B' });
  const added = await mcp.callTool('mindleaf_add_edge', { map: '关联图', from: 'A', to: 'B', label: '核对' });
  const edgeId = /e_[a-z0-9]+/.exec(added.text)?.[0];
  assert.ok(edgeId, added.text);

  // read_map 里要能看到关联线清单（带 id）
  const read = await mcp.callTool('mindleaf_read_map', { map: '关联图' });
  assert.match(read.text, /关联线（1 条/);
  assert.match(read.text, new RegExp(edgeId));

  const updated = await mcp.callTool('mindleaf_update_edge', {
    map: '关联图',
    id: edgeId,
    label: '核对解析',
    color: '#be123c',
    note: '给自己看',
    annotation: '这条依赖过时了',
  });
  assert.equal(updated.isError, false, updated.text);

  const json = await mcp.callTool('mindleaf_read_map', { map: '关联图', format: 'json' });
  const edge = JSON.parse(json.text.slice(json.text.indexOf('{'))).edges.find((item) => item.id === edgeId);
  assert.deepEqual(
    { label: edge.label, color: edge.color, note: edge.note, annotation: edge.annotation },
    { label: '核对解析', color: '#be123c', note: '给自己看', annotation: '这条依赖过时了' },
  );

  // 关联线批注也要出现在 list_annotations 里
  const annotations = await mcp.callTool('mindleaf_list_annotations', { map: '关联图' });
  assert.match(annotations.text, /关联线/);
  assert.match(annotations.text, /这条依赖过时了/);

  const removed = await mcp.callTool('mindleaf_remove_edge', { map: '关联图', id: edgeId });
  assert.equal(removed.isError, false, removed.text);
  const after = await mcp.callTool('mindleaf_read_map', { map: '关联图', format: 'json' });
  assert.equal(JSON.parse(after.text.slice(after.text.indexOf('{'))).edges.length, 0);
});

test('MCP: 批注 —— read_map 提示、list_annotations 汇总、改完能清空', async (t) => {
  const projectDir = tempProject();
  const mcp = await startMcp(projectDir);
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });

  await mcp.callTool('mindleaf_create_map', { title: '批注图', rootText: '根' });
  const branch = await mcp.callTool('mindleaf_add_node', { map: '批注图', text: '第三章' });
  const branchId = /〔(n_[a-z0-9]+)〕/.exec(branch.text)?.[1];

  // 没人写批注时，list_annotations 是空的
  const empty = await mcp.callTool('mindleaf_list_annotations', {});
  assert.match(empty.text, /没有待处理的批注/);

  // 人类写一条批注（用 update_node 模拟，网页里是同一个 op）
  const wrote = await mcp.callTool('mindleaf_update_node', {
    map: '批注图',
    id: branchId,
    annotation: '把这一章拆成两节',
  });
  assert.equal(wrote.isError, false, wrote.text);

  // read_map 顶部要有提示，outline 里要有 ⚑
  const read = await mcp.callTool('mindleaf_read_map', { map: '批注图' });
  assert.match(read.text, /有 1 条批注等你处理/);
  assert.match(read.text, /⚑ 批注: 把这一章拆成两节/);

  const listed = await mcp.callTool('mindleaf_list_annotations', {});
  assert.match(listed.text, /批注图/);
  assert.match(listed.text, /把这一章拆成两节/);
  assert.match(listed.text, new RegExp(branchId));

  // 处理完清空
  const cleared = await mcp.callTool('mindleaf_update_node', { map: '批注图', id: branchId, annotation: '' });
  assert.equal(cleared.isError, false, cleared.text);
  const after = await mcp.callTool('mindleaf_list_annotations', {});
  assert.match(after.text, /没有待处理的批注/);
  const reread = await mcp.callTool('mindleaf_read_map', { map: '批注图' });
  assert.doesNotMatch(reread.text, /⚑/, '清空后不应再出现批注');
});

test('MCP: 标签 —— update_map 打标签、list_map 过滤、list_tags 汇总', async (t) => {
  const projectDir = tempProject();
  const mcp = await startMcp(projectDir);
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });

  await mcp.callTool('mindleaf_create_map', { title: '架构评审', tags: ['项目', '架构'] });
  await mcp.callTool('mindleaf_create_map', { title: '读书笔记', tags: ['学习'] });
  await mcp.callTool('mindleaf_create_map', { title: '无标签' });

  const list = await mcp.callTool('mindleaf_list_maps');
  assert.match(list.text, /\[项目, 架构\]/);
  assert.match(list.text, /标签：/, '列表底部应给出标签汇总');

  const filtered = await mcp.callTool('mindleaf_list_maps', { tag: '架构' });
  assert.match(filtered.text, /架构评审/);
  assert.equal(filtered.text.includes('读书笔记'), false);
  assert.match(filtered.text, /标签「架构」/);

  const none = await mcp.callTool('mindleaf_list_maps', { tag: '不存在' });
  assert.match(none.text, /没有带标签/);

  const tags = await mcp.callTool('mindleaf_list_tags');
  assert.match(tags.text, /项目/);
  assert.match(tags.text, /学习/);

  const tagged = await mcp.callTool('mindleaf_update_map', { map: '无标签', tags: ['项目', '待补'] });
  assert.match(tagged.text, /标签=项目、待补/);

  const read = await mcp.callTool('mindleaf_read_map', { map: '无标签' });
  assert.match(read.text, /标签 项目、待补/);

  const cleared = await mcp.callTool('mindleaf_update_map', { map: '无标签', tags: [] });
  assert.match(cleared.text, /标签=（无）/);
  const afterClear = await mcp.callTool('mindleaf_list_maps', { tag: '待补' });
  assert.match(afterClear.text, /没有带标签/);
});

test('MCP: 错误处理不影响后续调用', async (t) => {
  const projectDir = tempProject();
  const mcp = await startMcp(projectDir);
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const missing = await mcp.callTool('mindleaf_read_map', { map: '不存在的图' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /找不到导图/);

  const badNode = await mcp.callTool('mindleaf_add_node', { map: '不存在的图', text: 'x' });
  assert.equal(badNode.isError, true);

  const created = await mcp.callTool('mindleaf_create_map', { title: '恢复图' });
  assert.equal(created.isError, false, '出错后仍应能正常工作');
});

test('MCP: 资源/提示类请求返回空列表而不是报错', async (t) => {
  const projectDir = tempProject();
  const mcp = await startMcp(projectDir);
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.deepEqual(await mcp.request('resources/list'), { resources: [] });
  assert.deepEqual(await mcp.request('prompts/list'), { prompts: [] });
  assert.deepEqual(await mcp.request('resources/templates/list'), { resourceTemplates: [] });
});

test('MCP: stdout 只有 JSON-RPC，日志走 stderr', async (t) => {
  const projectDir = tempProject();
  const mcp = await startMcp(projectDir);
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  await mcp.callTool('mindleaf_list_maps');
  const logs = mcp.stderr.join('');
  assert.match(logs, /MCP server/, '启动日志应写 stderr');
  assert.equal(mcp.notifications.filter((message) => message.id !== undefined).length, 0);
});

test('MCP: 多进程并发写同一导图不丢结构', async (t) => {
  const projectDir = tempProject();
  const a = await startMcp(projectDir);
  const b = await startMcp(projectDir);
  t.after(async () => {
    await a.close();
    await b.close();
  });
  for (const mcp of [a, b]) await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  await a.callTool('mindleaf_create_map', { title: '并发图' });
  await Promise.all([
    a.callTool('mindleaf_add_node', { map: '并发图', text: 'A 进程写入' }),
    b.callTool('mindleaf_add_node', { map: '并发图', text: 'B 进程写入' }),
  ]);
  const read = await a.callTool('mindleaf_read_map', { map: '并发图', format: 'json' });
  const parsed = JSON.parse(read.text.slice(read.text.indexOf('{')));
  assert.equal(parsed.nodes.length, 3, '两个进程各加一个节点，最终应有 3 个节点');
});
