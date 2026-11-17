import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from '../src/server/store.mjs';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'mindleaf.mjs');

const tempProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindleaf-cli-'));
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify({ version: 1, mapsDir: 'maps' }), 'utf8');
  return dir;
};

const run = async (projectDir, args, options = {}) => {
  const { stdout, stderr } = await exec(process.execPath, [BIN, ...args, '--project', projectDir], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1' },
    ...options,
  });
  return { stdout, stderr };
};

const runFail = async (projectDir, args) => {
  try {
    await run(projectDir, args);
    throw new Error('命令本应失败却成功了');
  } catch (error) {
    return { code: error.code, stderr: error.stderr ?? '' };
  }
};

test('CLI: --help 与 --version', async () => {
  const projectDir = tempProject();
  const help = await run(projectDir, ['--help']);
  assert.match(help.stdout, /mindleaf/);
  assert.match(help.stdout, /mm serve/);
  assert.match(help.stdout, /mm mcp/);
  const version = await run(projectDir, ['--version']);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('CLI: doctor 报告环境', async () => {
  const projectDir = tempProject();
  const { stdout } = await run(projectDir, ['doctor']);
  assert.match(stdout, /Mindleaf 环境检查/);
  assert.match(stdout, /导图目录/);
  assert.match(stdout, /可导出/);
  assert.match(stdout, /Agent 接入/);
});

test('CLI: templates 列出模板', async () => {
  const projectDir = tempProject();
  const { stdout } = await run(projectDir, ['templates']);
  assert.match(stdout, /thesis-outline/);
  assert.match(stdout, /论文提纲/);
  const json = await run(projectDir, ['templates', '--json']);
  const parsed = JSON.parse(json.stdout);
  assert.ok(parsed.length >= 8);
});

test('CLI: new（含模板）→ list → show → path', async () => {
  const projectDir = tempProject();
  const created = await run(projectDir, ['new', '项目规划', '--template', 'project-roadmap']);
  assert.match(created.stdout, /已创建/);
  assert.match(created.stdout, /模板/);

  const list = await run(projectDir, ['list']);
  assert.match(list.stdout, /项目规划/);
  const json = await run(projectDir, ['list', '--json']);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.maps.length, 1);
  assert.ok(parsed.maps[0].nodes >= 8);

  const show = await run(projectDir, ['show', '项目规划']);
  assert.match(show.stdout, /里程碑/);
  assert.match(show.stdout, /〔root〕/);

  const md = await run(projectDir, ['show', '项目规划', '--md']);
  assert.match(md.stdout, /^# 项目规划/m);

  const filePath = await run(projectDir, ['path', '项目规划']);
  assert.ok(fs.existsSync(filePath.stdout.trim()));
});

test('CLI: add / set / mv / edge / rm', async () => {
  const projectDir = tempProject();
  await run(projectDir, ['new', '图谱']);
  const added = await run(projectDir, ['add', '图谱', '第一章', '--note', '这一章讲背景']);
  assert.match(added.stdout, /新增/);
  await run(projectDir, ['add', '图谱', '第二章']);
  const child = await run(projectDir, ['add', '图谱', '1.1 小节', '--parent', '第一章']);
  assert.match(child.stdout, /新增/);

  const moved = await run(projectDir, ['mv', '图谱', '第二章', '第一章']);
  assert.match(moved.stdout, /已把/);

  const updated = await run(projectDir, ['set', '图谱', '第一章', '--text', '第 1 章 绪论', '--color', '#ffd166']);
  assert.match(updated.stdout, /已更新/);
  const doc = JSON.parse((await run(projectDir, ['show', '图谱', '--json'])).stdout);
  const renamed = doc.nodes.find((node) => node.text === '第 1 章 绪论');
  assert.equal(renamed.color, '#ffd166');

  const edge = await run(projectDir, ['edge', '图谱', '第 1 章 绪论', '第二章', '--label', '对比']);
  assert.match(edge.stdout, /关联线/);

  const edgeDoc = JSON.parse((await run(projectDir, ['show', '图谱', '--json'])).stdout);
  assert.equal(edgeDoc.edges.length, 1);
  assert.equal(edgeDoc.edges[0].label, '对比');

  const removed = await run(projectDir, ['rm', '图谱', '第二章']);
  assert.match(removed.stdout, /已删除/);
  const after = JSON.parse((await run(projectDir, ['show', '图谱', '--json'])).stdout);
  assert.equal(after.nodes.some((node) => node.text === '第二章'), false);
});

test('CLI: 标签 —— new --tags / tag 增删改清 / list --tag', async () => {
  const projectDir = tempProject();
  const created = await run(projectDir, ['new', '架构评审', '--tags', '项目,架构']);
  assert.match(created.stdout, /标签 项目、架构/);
  await run(projectDir, ['new', '读书笔记']);

  const added = await run(projectDir, ['tag', '读书笔记', '--add', '学习,项目']);
  assert.match(added.stdout, /标签已更新/);

  const list = await run(projectDir, ['list']);
  assert.match(list.stdout, /架构评审/);
  assert.match(list.stdout, /项目,架构/);

  const filtered = await run(projectDir, ['list', '--tag', '项目']);
  assert.match(filtered.stdout, /2 个导图（标签 项目）/);

  const removed = await run(projectDir, ['tag', '架构评审', '--remove', '架构']);
  assert.match(removed.stdout, /项目/);
  const shown = await run(projectDir, ['tag', '架构评审']);
  assert.match(shown.stdout, /项目/);

  const replaced = await run(projectDir, ['tag', '读书笔记', '--set', '学习']);
  assert.match(replaced.stdout, /学习/);

  const cleared = await run(projectDir, ['tag', '读书笔记', '--clear']);
  assert.match(cleared.stdout, /（无）/);

  const noTag = await run(projectDir, ['list', '--tag', '学习']);
  assert.match(noTag.stdout, /没有带标签「学习」的导图/);

  const show = await run(projectDir, ['show', '架构评审']);
  assert.match(show.stdout, /标签 项目/);
});

test('CLI: 三种颜色与 --subtree', async () => {
  const projectDir = tempProject();
  await run(projectDir, ['new', '配色图']);
  await run(projectDir, ['add', '配色图', '分支']);
  await run(projectDir, ['add', '配色图', '子节点', '--parent', '分支']);

  const styled = await run(projectDir, ['set', '配色图', '分支', '--color', '#fecdd3', '--text-color', '#b91c1c', '--line-color', '#0ea5e9']);
  assert.match(styled.stdout, /已更新/);
  let doc = JSON.parse((await run(projectDir, ['show', '配色图', '--json'])).stdout);
  let branch = doc.nodes.find((node) => node.text === '分支');
  assert.deepEqual(
    { color: branch.color, textColor: branch.textColor, lineColor: branch.lineColor },
    { color: '#fecdd3', textColor: '#b91c1c', lineColor: '#0ea5e9' },
  );

  const subtree = await run(projectDir, ['set', '配色图', '分支', '--color', '#bbf7d0', '--subtree']);
  assert.match(subtree.stdout, /含子节点/);
  doc = JSON.parse((await run(projectDir, ['show', '配色图', '--json'])).stdout);
  branch = doc.nodes.find((node) => node.text === '分支');
  const child = doc.nodes.find((node) => node.text === '子节点');
  assert.equal(branch.color, '#bbf7d0');
  assert.equal(child.color, '#bbf7d0', '子节点跟着一起改');

  // 子树模式不接受非颜色参数
  const mixed = await runFail(projectDir, ['set', '配色图', '分支', '--text', '改名', '--color', '#fff', '--subtree']);
  assert.match(mixed.stderr, /只能改颜色/);
});

test('CLI: 字号 / 字体 / 框宽高与 fonts 命令', async () => {
  const projectDir = tempProject();
  await run(projectDir, ['new', '排版']);
  await run(projectDir, ['add', '排版', '分支']);
  await run(projectDir, ['add', '排版', '子节点', '--parent', '分支']);

  const fonts = await run(projectDir, ['fonts']);
  assert.match(fonts.stdout, /楷体/);
  assert.match(fonts.stdout, /mono/);

  const styled = await run(projectDir, ['set', '排版', '分支', '--font-size', '22', '--font', 'kai', '--width', '220', '--height', '90']);
  assert.match(styled.stdout, /已更新/);
  let doc = JSON.parse((await run(projectDir, ['show', '排版', '--json'])).stdout);
  let branch = doc.nodes.find((node) => node.text === '分支');
  assert.deepEqual(
    { fontSize: branch.fontSize, font: branch.font, boxWidth: branch.boxWidth, boxHeight: branch.boxHeight },
    { fontSize: 22, font: 'kai', boxWidth: 220, boxHeight: 90 },
  );

  const subtree = await run(projectDir, ['set', '排版', '分支', '--font-size', '16', '--subtree']);
  assert.match(subtree.stdout, /含子节点/);
  doc = JSON.parse((await run(projectDir, ['show', '排版', '--json'])).stdout);
  branch = doc.nodes.find((node) => node.text === '分支');
  const child = doc.nodes.find((node) => node.text === '子节点');
  assert.equal(branch.fontSize, 16);
  assert.equal(child.fontSize, 16, '子节点跟着改');

  const mixed = await runFail(projectDir, ['set', '排版', '分支', '--width', '120', '--subtree']);
  assert.match(mixed.stderr, /只能改颜色/);
});

test('CLI: 后台启动 → 已在运行 → stop 收尾', async () => {
  const projectDir = tempProject();
  const stateFile = path.join(projectDir, '.mindleaf', 'server.json');

  const started = await run(projectDir, ['serve', '--detach', '--port', '0']);
  assert.match(started.stdout, /已在后台启动/, started.stdout);
  assert.ok(fs.existsSync(stateFile), '应写出状态文件');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(Number.isInteger(state.pid) && state.pid > 0);
  assert.ok(state.url.startsWith('http://127.0.0.1:'));

  // 健康检查能通
  const health = await fetch(`${state.url}/api/health`);
  assert.equal(health.status, 200);

  // 再启动一次：应识别为"已经在后台运行"
  const again = await run(projectDir, ['serve', '--detach', '--port', '0']);
  assert.match(again.stdout, /已经在后台运行/, again.stdout);

  // stop
  const stopped = await run(projectDir, ['stop']);
  assert.match(stopped.stdout, /已关闭后台服务/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fs.existsSync(stateFile), false, '状态文件应被清掉');
  await assert.rejects(fetch(`${state.url}/api/health`, { signal: AbortSignal.timeout(800) }), '服务应已停止');

  // 没在跑的时候 stop 不报错
  const none = await run(projectDir, ['stop']);
  assert.match(none.stdout, /没有在后台运行/);
});

test('CLI: 批注 —— set --annotation、annotations 列表、清空', async () => {
  const projectDir = tempProject();
  await run(projectDir, ['new', '批注图']);
  await run(projectDir, ['add', '批注图', '第三章']);

  const wrote = await run(projectDir, ['set', '批注图', '第三章', '--annotation', '拆成两节']);
  assert.match(wrote.stdout, /已更新/);

  // show 里能看到批注
  const shown = await run(projectDir, ['show', '批注图']);
  assert.match(shown.stdout, /⚑ 批注: 拆成两节/);

  const listed = await run(projectDir, ['annotations']);
  assert.match(listed.stdout, /批注图/);
  assert.match(listed.stdout, /拆成两节/);
  assert.match(listed.stdout, /清掉/);

  // 只查一张图
  const single = await run(projectDir, ['annotations', '批注图']);
  assert.match(single.stdout, /拆成两节/);

  // 清空
  await run(projectDir, ['set', '批注图', '第三章', '--annotation', '']);
  const empty = await run(projectDir, ['annotations']);
  assert.match(empty.stdout, /没有待处理的批注/);
});

test('CLI: export 各种格式', async () => {
  const projectDir = tempProject();
  await run(projectDir, ['new', '导出测试']);
  await run(projectDir, ['add', '导出测试', '分支一']);
  const out = path.join(projectDir, 'out.svg');
  const svg = await run(projectDir, ['export', '导出测试', '-f', 'svg', '-o', out]);
  assert.match(svg.stdout, /SVG/);
  assert.ok(fs.existsSync(out));
  assert.match(fs.readFileSync(out, 'utf8'), /^<svg/);

  const mdFile = path.join(projectDir, 'out.md');
  await run(projectDir, ['export', '导出测试', '-f', 'md', '-o', mdFile]);
  assert.match(fs.readFileSync(mdFile, 'utf8'), /# 导出测试/);

  // 默认写到 exports/
  const auto = await run(projectDir, ['export', '导出测试', '-f', 'json']);
  assert.match(auto.stdout, /JSON/);
  const exportsDir = path.join(projectDir, 'exports');
  assert.ok(fs.existsSync(exportsDir));
  assert.equal(fs.readdirSync(exportsDir).length, 1);

  const bad = await runFail(projectDir, ['export', '导出测试', '-f', 'bmp']);
  assert.match(bad.stderr, /不支持的格式/);
});

test('CLI: import markdown / log / rollback', async () => {
  const projectDir = tempProject();
  const mdFile = path.join(projectDir, 'outline.md');
  fs.writeFileSync(mdFile, '# 综述\n\n## 主题一\n\n- 备注\n\n## 主题二\n', 'utf8');
  const imported = await run(projectDir, ['import', 'new', mdFile]);
  assert.match(imported.stdout, /已导入/);

  const json = JSON.parse((await run(projectDir, ['list', '--json'])).stdout);
  assert.equal(json.maps.length, 1);
  const slug = json.maps[0].slug;

  const log = await run(projectDir, ['log', slug]);
  assert.match(log.stdout, /当前 rev/);

  const history = await run(projectDir, ['log', slug, '--json']);
  const parsed = JSON.parse(history.stdout);
  assert.ok(Array.isArray(parsed.journal));
});

test('CLI: config 查看与修改导图目录', async () => {
  const projectDir = tempProject();
  const before = JSON.parse((await run(projectDir, ['config'])).stdout);
  assert.ok(before.mapsDir.endsWith('maps'));
  const changed = await run(projectDir, ['config', '--maps-dir', 'notes/maps']);
  assert.match(changed.stdout, /已改为/);
  const after = JSON.parse((await run(projectDir, ['config'])).stdout);
  assert.ok(after.mapsDir.endsWith(path.join('notes', 'maps')));
  assert.ok(fs.existsSync(after.mapsDir));
});

test('CLI: 错误命令与错误参数', async () => {
  const projectDir = tempProject();
  const unknown = await runFail(projectDir, ['nonsense']);
  assert.match(unknown.stderr, /未知命令/);
  const missing = await runFail(projectDir, ['show']);
  assert.match(missing.stderr, /缺少参数/);
  const noMap = await runFail(projectDir, ['show', '不存在的图']);
  assert.match(noMap.stderr, /找不到导图/);
  const badNode = await runFail(projectDir, ['rm', '图谱', 'x']);
  assert.match(badNode.stderr, /找不到导图/);
});
