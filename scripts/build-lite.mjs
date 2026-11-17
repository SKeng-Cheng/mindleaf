#!/usr/bin/env node
/**
 * 生成 lite 分支：只保留"能直接跑起来"的文件，方便别人 clone 一个小仓库。
 *
 * 用法:
 *   node scripts/build-lite.mjs            # 生成/更新本地 lite 分支
 *   node scripts/build-lite.mjs --dry-run  # 只列出会带哪些文件
 *   node scripts/build-lite.mjs --push     # 生成后顺手 git push -f origin lite
 *
 * 设计：
 * - lite 每次都是一个**孤儿提交**（没有父提交），内容完全由 main 的当前状态生成，
 *   所以它不会累积历史，也不会和 main 分叉——改了 main 重新跑一次就行。
 * - lite 里的 README 是 main 的 README 去掉截图后的版本，顶部加一段说明。
 * - 这个分支是可再生的产物，别在 lite 上直接改东西（下次生成会被覆盖）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..');
const BRANCH = 'lite';

/** 只带这些：能跑工具、能接 AI、有模板和示例，没有测试/截图/开发文档。 */
const KEEP = [
  'bin',
  'src',
  'web',
  'templates',
  'examples',
  'integrations',
  'package.json',
  'mindleaf.json',
  'LICENSE',
  'README.md',
  'MANUAL.md',
  '.gitignore',
  '启动 Mindleaf.command',
];

/** lite 分支里不该存在的（就算在 KEEP 目录下也要剔掉）。 */
const DROP = ['integrations/.rendered'];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const PUSH = args.includes('--push');

const git = (gitArgs, options = {}) =>
  execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', stdio: options.stdio ?? 'pipe', ...options }).trim();

function listFiles() {
  const out = git(['ls-files', '-z']);
  return out.split('\0').filter(Boolean);
}

function shouldKeep(file) {
  if (DROP.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))) return false;
  return KEEP.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

/** 把 main 的 README 变成 lite 版：去掉引用 docs/images 的图片和图片容器，顶部加说明。 */
function buildReadme(source, baseSha) {
  const lines = source.split('\n');
  const kept = [];
  for (const line of lines) {
    if (line.includes('docs/images/')) continue;
    if (/^<p align="center">\s*$/.test(line)) continue;
    if (/^<\/p>\s*$/.test(line)) continue;
    if (/^<sub>.*<\/sub>\s*$/.test(line)) continue;
    kept.push(line);
  }
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n');

  const banner = [
    '',
    '> **这是 lite 分支**：实现功能的最小包，45 个文件、解压后 481 KB（zip 159 KB），',
    '> 只保留跑起来需要的代码和模板，没有测试、截图和开发文档。',
    '> 完整版在 `main` 分支：70 个文件、解压后 3.8 MB。',
    `> 本分支由 \`scripts/build-lite.mjs\` 从 main@${baseSha.slice(0, 7)} 自动生成，**不要直接改它**。`,
    '',
  ].join('\n');

  // 插在第一个标题（# Mindleaf）之后
  const index = text.indexOf('\n');
  return `${text.slice(0, index)}\n${banner}${text.slice(index + 1)}`;
}

/** MANUAL 在 lite 里同样去掉截图引用（lite 不带 docs/images）。 */
function buildManual(source, baseSha) {
  const lines = source.split('\n');
  const kept = [];
  for (const line of lines) {
    if (line.includes('docs/images/')) continue;
    if (/^<p align="center">\s*$/.test(line)) continue;
    if (/^<\/p>\s*$/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** lite 的 package.json：只留这次真的带上的 files，去掉跑不了的测试脚本。 */
function buildPackageJson(source, included) {
  const pkg = JSON.parse(source);
  if (Array.isArray(pkg.files)) {
    pkg.files = pkg.files.filter((entry) => included.some((file) => file === entry || file.startsWith(`${entry}/`)));
  }
  if (pkg.scripts) {
    delete pkg.scripts.test;
    delete pkg.scripts['test:e2e'];
  }
  return JSON.stringify(pkg, null, 2) + '\n';
}

function main() {
  let baseSha;
  try {
    baseSha = git(['rev-parse', 'HEAD']);
  } catch {
    console.error('这个目录还不是 git 仓库（或者还没有提交）');
    process.exit(1);
  }

  const all = listFiles();
  const files = all.filter(shouldKeep);
  if (!files.length) {
    console.error('白名单没匹配到任何文件，先检查 KEEP 配置');
    process.exit(1);
  }

  const totalBytes = files.reduce((sum, file) => sum + fs.statSync(path.join(ROOT, file)).size, 0);
  console.log(`main@${baseSha.slice(0, 7)} · 完整仓库 ${all.length} 个文件，lite 只带 ${files.length} 个 · ${(totalBytes / 1024).toFixed(0)} KB`);

  if (DRY_RUN) {
    for (const file of files) console.log(`  ${file}`);
    console.log('\n（--dry-run 只列出，不改分支）');
    return;
  }

  // 工作树（要提交的文件）和临时文件（index、tar）分开放，避免把临时文件也提进去
  const workTree = fs.mkdtempSync(path.join(os.tmpdir(), 'mindleaf-lite-tree-'));
  const metaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindleaf-lite-meta-'));
  const indexFile = path.join(metaDir, 'index');
  const tarFile = path.join(metaDir, 'tree.tar');
  try {
    // 1. 把白名单里的文件从 HEAD 导出来
    const archiveFiles = files.filter((file) => !['README.md', 'MANUAL.md'].includes(file));
    git(['archive', baseSha, '--prefix=', '-o', tarFile, ...archiveFiles]);
    execFileSync('tar', ['-x', '-f', tarFile, '-C', workTree], { stdio: 'pipe' });

    // 2. README / MANUAL 与 package.json 重新生成
    fs.writeFileSync(path.join(workTree, 'README.md'), buildReadme(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), baseSha));
    fs.writeFileSync(path.join(workTree, 'MANUAL.md'), buildManual(fs.readFileSync(path.join(ROOT, 'MANUAL.md'), 'utf8'), baseSha));
    fs.writeFileSync(
      path.join(workTree, 'package.json'),
      buildPackageJson(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), [...files, 'package.json']),
    );

    // 3. 用临时 index 生成一个孤儿提交
    const gitEnv = { ...process.env, GIT_INDEX_FILE: indexFile };
    execFileSync('git', ['read-tree', '--empty'], { cwd: ROOT, env: gitEnv });
    execFileSync('git', ['--work-tree', workTree, 'add', '-A'], { cwd: ROOT, env: gitEnv });
    const tree = execFileSync('git', ['write-tree'], { cwd: ROOT, env: gitEnv, encoding: 'utf8' }).trim();
    const message = [
      'lite：只带运行所需的文件（自动生成，请勿直接修改）',
      '',
      `来源：main@${baseSha.slice(0, 7)}`,
      '生成：scripts/build-lite.mjs（在 main 上跑 `npm run lite`）',
      '',
      '完整版（含测试、截图、英文 README、开发文档）见 main 分支。',
    ].join('\n');
    const commit = execFileSync('git', ['commit-tree', tree, '-m', message], {
      cwd: ROOT,
      env: { ...gitEnv, GIT_AUTHOR_NAME: git(['config', 'user.name']) || 'mindleaf', GIT_AUTHOR_EMAIL: git(['config', 'user.email']) || 'mindleaf@localhost' },
      encoding: 'utf8',
    }).trim();

    execFileSync('git', ['branch', '-f', BRANCH, commit], { cwd: ROOT });
    console.log(`\n已生成分支 ${BRANCH} → ${commit.slice(0, 7)}（孤儿提交，无历史累积）`);
    console.log(`文件 ${files.length} 个 · ${(totalBytes / 1024).toFixed(0)} KB`);

    if (PUSH) {
      execFileSync('git', ['push', '-f', 'origin', BRANCH], { cwd: ROOT, stdio: 'inherit' });
    } else {
      console.log(`\n下一步：git push -f origin ${BRANCH}`);
      console.log(`别人拉取：git clone -b ${BRANCH} --depth 1 https://github.com/SKeng-Cheng/mindleaf.git`);
    }
  } finally {
    fs.rmSync(workTree, { recursive: true, force: true });
    fs.rmSync(metaDir, { recursive: true, force: true });
  }
}

main();
