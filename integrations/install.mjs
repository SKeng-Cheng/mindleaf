#!/usr/bin/env node
/**
 * 一键接入脚本：把 Mindleaf 注册成各家 agent 的 MCP 服务器。
 *
 *   node integrations/install.mjs                     # 只打印配置片段（安全，不改任何文件）
 *   node integrations/install.mjs --apply             # 应用到全部已安装的客户端
 *   node integrations/install.mjs --target codex --apply
 *   node integrations/install.mjs --target dsh        # 渲染 DSH bundle，供 Plugins 面板安装
 *   node integrations/install.mjs --check             # 检查已配置情况
 *
 * 设计原则：只做"最小必要修改 + 备份"，绝不覆盖你已有的 mcpServers 条目。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.resolve(HERE, '..');
const BIN = path.join(TOOL_DIR, 'bin', 'mindleaf.mjs');
const SERVER_NAME = 'mindleaf';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const target = value('target', 'all');
const apply = flag('apply');
const dryRun = !apply || flag('dry-run');
const checkOnly = flag('check');

const c = {
  bold: (text) => `\u001b[1m${text}\u001b[0m`,
  dim: (text) => `\u001b[2m${text}\u001b[0m`,
  green: (text) => `\u001b[32m${text}\u001b[0m`,
  yellow: (text) => `\u001b[33m${text}\u001b[0m`,
  red: (text) => `\u001b[31m${text}\u001b[0m`,
  blue: (text) => `\u001b[34m${text}\u001b[0m`,
};

/** 找项目目录：--project > mindleaf.json 向上查找 > 工具目录。 */
function resolveProject() {
  const explicit = value('project') ?? process.env.MINDLEAF_PROJECT;
  if (explicit) return path.resolve(explicit);
  let dir = process.cwd();
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(dir, 'mindleaf.json')) || fs.existsSync(path.join(dir, '.mindleaf'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return TOOL_DIR;
}

const projectDir = resolveProject();
const nodePath = process.execPath;

const jsonServerEntry = () => ({
  type: 'stdio',
  command: nodePath,
  args: [BIN, 'mcp', '--project', projectDir],
  env: { PATH: `${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin` },
});

const backup = (file) => {
  if (!fs.existsSync(file)) return null;
  const target_ = `${file}.mindleaf.bak`;
  fs.copyFileSync(file, target_);
  return target_;
};

const ensureDir = (file) => fs.mkdirSync(path.dirname(file), { recursive: true });

const writeFile = (file, content) => {
  ensureDir(file);
  fs.writeFileSync(file, content, 'utf8');
};

// ---------------------------------------------------------------------------
// 各客户端
// ---------------------------------------------------------------------------

const targets = {
  'claude-code': {
    label: 'Claude Code（项目级 .mcp.json）',
    configPath: () => path.join(projectDir, '.mcp.json'),
    snippet: () => JSON.stringify({ mcpServers: { [SERVER_NAME]: jsonServerEntry() } }, null, 2),
    apply: () => {
      const file = path.join(projectDir, '.mcp.json');
      let data = {};
      if (fs.existsSync(file)) {
        try {
          data = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          throw new Error(`${file} 不是合法 JSON，请手动修改`);
        }
        backup(file);
      }
      data.mcpServers = { ...(data.mcpServers ?? {}), [SERVER_NAME]: jsonServerEntry() };
      writeFile(file, JSON.stringify(data, null, 2) + '\n');
      return { file, note: '首次在 claude 里打开该项目时，需要在 /mcp 或启动提示里批准一次。' };
    },
    check: () => {
      const file = path.join(projectDir, '.mcp.json');
      if (!fs.existsSync(file)) return '未配置';
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data.mcpServers?.[SERVER_NAME] ? '已配置' : '未配置';
      } catch {
        return '文件损坏';
      }
    },
  },
  'claude-desktop': {
    label: 'Claude Desktop',
    configPath: () =>
      process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(process.env.APPDATA ?? os.homedir(), 'Claude', 'claude_desktop_config.json'),
    snippet: () => JSON.stringify({ mcpServers: { [SERVER_NAME]: jsonServerEntry() } }, null, 2),
    apply: () => {
      const file = targets['claude-desktop'].configPath();
      let data = {};
      if (fs.existsSync(file)) {
        try {
          data = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          throw new Error(`${file} 不是合法 JSON，请手动修改`);
        }
        backup(file);
      }
      data.mcpServers = { ...(data.mcpServers ?? {}), [SERVER_NAME]: jsonServerEntry() };
      writeFile(file, JSON.stringify(data, null, 2) + '\n');
      return { file, note: '需要完全退出并重启 Claude Desktop 才会生效。' };
    },
    check: () => {
      const file = targets['claude-desktop'].configPath();
      if (!fs.existsSync(file)) return '未配置';
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers?.[SERVER_NAME] ? '已配置' : '未配置';
      } catch {
        return '文件损坏';
      }
    },
  },
  codex: {
    label: 'Codex CLI（~/.codex/config.toml）',
    configPath: () => path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml'),
    snippet: () =>
      [
        `[mcp_servers.${SERVER_NAME}]`,
        `command = ${JSON.stringify(nodePath)}`,
        `args = ${JSON.stringify([BIN, 'mcp', '--project', projectDir])}`,
        `cwd = ${JSON.stringify(projectDir)}`,
        'startup_timeout_sec = 20',
        'tool_timeout_sec = 120',
        '',
        `[mcp_servers.${SERVER_NAME}.env]`,
        `PATH = ${JSON.stringify(`${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`)}`,
      ].join('\n'),
    apply: () => {
      const file = targets.codex.configPath();
      const block = targets.codex.snippet();
      let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (fs.existsSync(file)) backup(file);
      const lines = content.split('\n');
      const startIndex = lines.findIndex((line) => line.trim() === `[mcp_servers.${SERVER_NAME}]`);
      if (startIndex >= 0) {
        // 删掉旧块：从表头到下一个顶层表（不是 mcp_servers.<name>.* 的子表）
        let endIndex = lines.length;
        for (let i = startIndex + 1; i < lines.length; i += 1) {
          const trimmed = lines[i].trim();
          if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            if (!trimmed.startsWith(`[mcp_servers.${SERVER_NAME}`)) {
              endIndex = i;
              break;
            }
          }
        }
        lines.splice(startIndex, endIndex - startIndex, ...block.split('\n'));
        content = lines.join('\n');
      } else {
        content = `${content.replace(/\s*$/, '')}${content.trim() ? '\n\n' : ''}${block}\n`;
      }
      writeFile(file, content);
      return { file, note: '用 `codex mcp list` 确认；新开 codex 会话即可看到 mindleaf 工具。' };
    },
    check: () => {
      const file = targets.codex.configPath();
      if (!fs.existsSync(file)) return '未配置';
      return new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]`, 'm').test(fs.readFileSync(file, 'utf8')) ? '已配置' : '未配置';
    },
  },
  dsh: {
    label: 'DeepSeek Harness（配置型 bundle）',
    configPath: () => path.join(TOOL_DIR, 'integrations', '.rendered', 'dsh', 'mindleaf-mcp'),
    snippet: () =>
      [
        `# 在 DSH 的 Plugins → Add plugin 里选择这个目录：`,
        `#   ${path.join(TOOL_DIR, 'integrations', '.rendered', 'dsh', 'mindleaf-mcp')}`,
        `# 安装后新开会话，用 mindleaf__list_maps 验证。`,
      ].join('\n'),
    apply: () => {
      const outDir = path.join(TOOL_DIR, 'integrations', '.rendered', 'dsh', 'mindleaf-mcp');
      const source = path.join(TOOL_DIR, 'integrations', 'dsh', 'mindleaf-mcp');
      const files = ['package.json', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'README.md'];
      for (const relative of files) {
        const from = path.join(source, relative);
        if (!fs.existsSync(from)) continue;
        let content = fs.readFileSync(from, 'utf8');
        if (relative.endsWith('.yml')) {
          content = content
            .replaceAll('__NODE__', nodePath)
            .replaceAll('__TOOL__', TOOL_DIR)
            .replaceAll('__PROJECT__', projectDir);
        }
        writeFile(path.join(outDir, relative), content);
      }
      return {
        file: outDir,
        note: `在 DSH 的 Plugins → Add plugin 里选择该目录安装；或在有插件管理权限的会话里执行 plugin_manager(install_bundle, target: "${outDir}")。`,
      };
    },
    check: () => {
      const outDir = path.join(TOOL_DIR, 'integrations', '.rendered', 'dsh', 'mindleaf-mcp');
      return fs.existsSync(outDir) ? `已渲染（${outDir}），安装状态请看 DSH 的 Plugins 面板` : '未渲染';
    },
  },
};

// ---------------------------------------------------------------------------

const selected = target === 'all' ? Object.keys(targets) : [target];
for (const name of selected) {
  if (!targets[name]) {
    console.error(c.red(`未知目标: ${name}（可用: ${Object.keys(targets).join(', ')}, all）`));
    process.exit(1);
  }
}

console.log(`${c.bold('Mindleaf 接入助手')}\n`);
console.log(`  node:    ${nodePath}`);
console.log(`  工具:    ${BIN}`);
console.log(`  项目:    ${projectDir}`);
console.log(`  模式:    ${checkOnly ? '检查' : dryRun ? '预览（不改文件）' : '写入'}\n`);

if (checkOnly) {
  for (const name of selected) {
    console.log(`  ${targets[name].label.padEnd(42, ' ')} ${targets[name].check()}`);
  }
  process.exit(0);
}

for (const name of selected) {
  const item = targets[name];
  console.log(c.blue(`■ ${item.label}`));
  console.log(c.dim(`  配置位置: ${item.configPath()}`));
  if (dryRun) {
    console.log(
      item.snippet()
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );
    console.log();
    continue;
  }
  try {
    const result = item.apply();
    console.log(`  ${c.green('✔')} 已写入 ${result.file}`);
    if (result.note) console.log(`  ${c.yellow('!')} ${result.note}`);
  } catch (error) {
    console.log(`  ${c.red('✘')} ${error.message}`);
  }
  console.log();
}

if (dryRun) {
  console.log(c.dim('以上只是预览。确认无误后加 --apply 真正写入（会先备份原文件）。'));
} else {
  console.log(c.dim('提示：PATH 里只有绝对路径，升级 Node 版本后请重新运行本脚本。'));
}
