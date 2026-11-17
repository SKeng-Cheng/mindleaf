/**
 * 命令行入口：serve / list / show / new / add / set / rm / mv / edge / export /
 * import / log / rollback / open / mcp / doctor / config。
 *
 * CLI 与网页、MCP 共用 Store，因此三条通道永远看到同一份文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Store, StoreError, findProjectRoot } from './server/store.mjs';
import { FONTS, outline, docStats, getNode, rootOf } from './core/doc.mjs';
import { fromMarkdown, guessTitle, toMarkdown } from './core/markdown.mjs';
import { resolveNodeRef } from './mcp/server.mjs';
import { EXPORT_FORMATS } from './export/exporters.mjs';
import { detectEngines, openInBrowser } from './export/raster.mjs';

const isTTY = process.stdout.isTTY;
const c = {
  dim: (text) => (isTTY ? `\u001b[2m${text}\u001b[0m` : text),
  bold: (text) => (isTTY ? `\u001b[1m${text}\u001b[0m` : text),
  green: (text) => (isTTY ? `\u001b[32m${text}\u001b[0m` : text),
  yellow: (text) => (isTTY ? `\u001b[33m${text}\u001b[0m` : text),
  blue: (text) => (isTTY ? `\u001b[34m${text}\u001b[0m` : text),
  red: (text) => (isTTY ? `\u001b[31m${text}\u001b[0m` : text),
};

const HELP = `${c.bold('mindleaf')} —— AI 友好的本地思维导图（零依赖）

用法: mm <命令> [选项]
常用:
  mm serve [--port 7788] [--open]     启动网页（人机共用同一份文件）
  mm list [--tag 标签]               列出全部导图（可按标签过滤）
  mm tag <导图> [--add a,b] [--remove c] [--set x,y] [--clear]   管理标签
  mm show <导图> [--json|--md]        查看导图（默认带 id 的大纲）
  mm new <标题> [--template 模板] [--tags a,b]   新建导图
  mm templates                       列出内置模板
  mm add <导图> <文字> [--parent 节点] 新增节点（父节点可写 id 或文字）
  mm set <导图> <节点> --text 新文字   修改节点（--note / 颜色 / 字号字体 / 框宽高 / --link / --subtree）
  mm fonts                           列出可用字体
  mm rm <导图> <节点>                 删除节点（含子树）
  mm mv <导图> <节点> <新父节点>       移动节点
  mm edge <导图> <起点> <终点> --label 加关联线
  mm export <导图> -f png|jpg|pdf|svg|md|json|html [-o 路径] [--scale 2]
  mm import <导图|new> <文件.md>      从 Markdown 导入
  mm log <导图> [--since 0]           查看改动历史（含人类在网页里的修改）
  mm rollback <导图> --rev 3          回滚到历史版本
  mm open [导图]                      启动并打开网页
  mm mcp                              以 MCP stdio 服务器运行（给 agent 用）
  mm doctor                           检查导出能力与环境
  mm config [--maps-dir 路径]         查看/修改项目配置（会被记住）

全局: --project <目录> 指定项目（默认向上查找 mindleaf.json）
`;

const parse = (argv) => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      project: { type: 'string' },
      port: { type: 'string' },
      open: { type: 'boolean' },
      host: { type: 'string' },
      json: { type: 'boolean' },
      md: { type: 'boolean' },
      markdown: { type: 'boolean' },
      outline: { type: 'boolean' },
      notes: { type: 'boolean', short: 'n' },
      parent: { type: 'string' },
      position: { type: 'string' },
      text: { type: 'string' },
      note: { type: 'string' },
      color: { type: 'string' },
      'text-color': { type: 'string' },
      'font-size': { type: 'string' },
      font: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      'line-color': { type: 'string' },
      subtree: { type: 'boolean' },
      link: { type: 'string', multiple: true },
      label: { type: 'string' },
      format: { type: 'string', short: 'f' },
      out: { type: 'string', short: 'o' },
      scale: { type: 'string' },
      quality: { type: 'string' },
      title: { type: 'string' },
      root: { type: 'string' },
      layout: { type: 'string' },
      template: { type: 'string', short: 't' },
      theme: { type: 'string' },
      since: { type: 'string' },
      rev: { type: 'string' },
      'maps-dir': { type: 'string' },
      tag: { type: 'string' },
      tags: { type: 'string' },
      add: { type: 'string' },
      remove: { type: 'string' },
      set: { type: 'string' },
      clear: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  return { values, positionals };
};

const makeStore = (values) => {
  const explicit = values.project ? path.resolve(values.project) : null;
  const projectDir = explicit ?? findProjectRoot(process.cwd()) ?? process.cwd();
  return new Store({ projectDir }).init();
};

const need = (positionals, index, name) => {
  const value = positionals[index];
  if (!value) throw new StoreError(`缺少参数: ${name}`, 'invalid_argument');
  return value;
};

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const printMapList = (store, { tag } = {}) => {
  const maps = store.list({ tag });
  if (!maps.length) {
    if (tag) console.log(c.dim(`没有带标签「${tag}」的导图。现有标签：${store.tagCounts().map((item) => item.tag).join('、') || '（无）'}`));
    else console.log(c.dim(`还没有导图。${store.mapsDir} 为空，用 mm new <标题> 新建。`));
    return;
  }
  const rows = maps.map((map) => [
    map.slug,
    map.title,
    `rev ${map.rev}`,
    `${map.nodes} 节点`,
    (map.tags ?? []).length ? (map.tags ?? []).join(',') : '—',
    (map.updatedAt ?? '').replace('T', ' ').slice(0, 16),
  ]);
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => displayWidth(row[index]))));
  for (const row of rows) {
    console.log(
      [
        c.bold(pad(row[0], widths[0])),
        pad(row[1], widths[1] + 2),
        c.dim(pad(row[2], widths[2])),
        c.dim(pad(row[3], widths[3])),
        c.blue(pad(row[4], widths[4])),
        c.dim(row[5]),
      ].join(' '),
    );
  }
  const counts = store.tagCounts();
  const tagLine = counts.length ? ` · 标签: ${counts.map((item) => `${item.tag}(${item.count})`).join(' ')}` : '';
  console.log(c.dim(`\n${maps.length} 个导图${tag ? `（标签 ${tag}）` : ''} · ${store.mapsDir}${tagLine}`));
};

const displayWidth = (text) => {
  let width = 0;
  for (const char of String(text ?? '')) width += /[\u1100-\uffff]/.test(char) ? 2 : 1;
  return width;
};
const pad = (text, width) => {
  const value = String(text ?? '');
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
};

async function cmdServe(values, positionals) {
  const store = makeStore(values);
  const { startServer } = await import('./server/http.mjs');
  const session = await startServer({ store, port: number(values.port, 7788), host: values.host });
  const mapFilter = positionals[0];
  const url = mapFilter ? `${session.url}/#${encodeURIComponent(mapFilter)}` : session.url;
  console.log(`${c.green('✔')} Mindleaf 已启动 ${c.bold(url)}`);
  console.log(c.dim(`  项目: ${store.projectDir}`));
  console.log(c.dim(`  导图: ${store.mapsDir}`));
  console.log(c.dim(`  浏览器能力: ${session.engines.chromium[0] ?? '未找到无头浏览器'}${session.engines.sips ? ' · sips 可用' : ''}`));
  console.log(c.dim('  Ctrl+C 停止'));
  if (values.open || mapFilter) await openInBrowser(url);
  await new Promise((resolve) => {
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
  });
  await session.close();
}

function cmdList(values) {
  const store = makeStore(values);
  const tag = values.tag ?? values.tags;
  if (values.json) {
    console.log(JSON.stringify({ project: store.summary(), maps: store.list({ tag }) }, null, 2));
    return;
  }
  printMapList(store, { tag });
}

function cmdShow(values, positionals) {
  const store = makeStore(values);
  const { doc, slug, file } = store.read(need(positionals, 0, '导图'));
  if (values.json) {
    console.log(JSON.stringify(doc, null, 2));
    return;
  }
  if (values.md || values.markdown) {
    console.log(toMarkdown(doc));
    return;
  }
  const stats = docStats(doc);
  const tagText = (doc.tags ?? []).length ? ` · 标签 ${doc.tags.join('、')}` : '';
  console.log(c.bold(`${doc.title}`) + c.dim(`  (${slug} · rev ${doc.rev} · ${stats.nodes} 节点 · 深 ${stats.maxDepth}${tagText})`));
  console.log(c.dim(file) + '\n');
  console.log(outline(doc, { withNotes: values.notes !== false, withLinks: true }));
}

function cmdNew(values, positionals) {
  const store = makeStore(values);
  const title = need(positionals, 0, '标题');
  const created = store.create({
    title,
    rootText: values.root,
    layout: values.layout,
    theme: values.theme,
    template: values.template,
    tags: values.tags ?? values.tag,
    by: 'cli',
  });
  console.log(
    `${c.green('✔')} 已创建「${created.doc.title}」${created.template ? `（模板：${created.template.title}）` : ''} → ${c.dim(created.file)}`,
  );
  const createdTags = (created.doc.tags ?? []).length ? ` · 标签 ${created.doc.tags.join('、')}` : '';
  console.log(c.dim(`  slug: ${created.slug} · 根节点: ${rootOf(created.doc).id} · ${docStats(created.doc).nodes} 节点${createdTags}`));
}

function cmdAdd(values, positionals) {
  const store = makeStore(values);
  const { doc: current } = store.read(need(positionals, 0, '导图'));
  const text = need(positionals, 1, '节点文字');
  const parent = values.parent ? resolveNodeRef(current, values.parent) : rootOf(current);
  const links = parseLinkArgs(values.link);
  const { doc, results } = store.applyOps(positionals[0], [
    { op: 'addNode', parent: parent.id, text, note: values.note, links, position: values.position },
  ], { by: 'cli' });
  const node = results[0];
  console.log(`${c.green('✔')} 新增 ${c.bold(node.id)}「${node.text}」 ← 「${parent.text}」${c.dim(`  rev ${doc.rev}`)}`);
}

function parseLinkArgs(rawLinks) {
  return (rawLinks ?? []).map((raw) => {
    const [kind, ...rest] = String(raw).split(':');
    const target = rest.join(':');
    if (['file', 'url', 'code'].includes(kind) && target) return { kind, target };
    return { kind: 'file', target: String(raw) };
  });
}

function cmdSet(values, positionals) {
  const store = makeStore(values);
  const { doc: current } = store.read(need(positionals, 0, '导图'));
  const node = resolveNodeRef(current, need(positionals, 1, '节点'));
  const ops = [];
  const patch = { op: 'updateNode', id: node.id };
  if (values.text !== undefined) patch.text = values.text;
  if (values.note !== undefined) patch.note = values.note;
  if (values.color !== undefined) patch.color = values.color;
  if (values['text-color'] !== undefined) patch.textColor = values['text-color'];
  if (values['line-color'] !== undefined) patch.lineColor = values['line-color'];
  if (values['font-size'] !== undefined) patch.fontSize = values['font-size'];
  if (values.font !== undefined) patch.font = values.font;
  if (values.width !== undefined) patch.boxWidth = values.width;
  if (values.height !== undefined) patch.boxHeight = values.height;
  if (values.subtree === true) patch.subtree = true;
  if (values.link !== undefined) patch.links = parseLinkArgs(values.link);
  if (Object.keys(patch).length > 2) ops.push(patch);
  if (values.parent !== undefined) {
    const parent = resolveNodeRef(current, values.parent);
    ops.push({ op: 'moveNode', id: node.id, parent: parent.id, position: values.position });
  }
  if (!ops.length) {
    throw new StoreError(
      '没有要修改的内容（--text / --note / 颜色 / --font-size / --font / --width / --height / --link / --parent）',
      'invalid_argument',
    );
  }
  const { doc } = store.applyOps(positionals[0], ops, { by: 'cli' });
  const updated = getNode(doc, node.id);
  const parentText = updated.parent ? `「${getNode(doc, updated.parent)?.text ?? updated.parent}」下` : '';
  const scopeText = values.subtree === true ? '（含子节点）' : '';
  console.log(`${c.green('✔')} 已更新 ${c.bold(updated.id)}${parentText}「${updated.text}」${scopeText}${c.dim(`  rev ${doc.rev}`)}`);
}

function cmdRemove(values, positionals) {
  const store = makeStore(values);
  const { doc: current } = store.read(need(positionals, 0, '导图'));
  const node = resolveNodeRef(current, need(positionals, 1, '节点'));
  const { doc, results } = store.applyOps(positionals[0], [{ op: 'removeNode', id: node.id }], { by: 'cli' });
  const removed = results[0]?.removed ?? [node.id];
  console.log(`${c.green('✔')} 已删除 ${removed.length} 个节点（含「${node.text}」）${c.dim(`  rev ${doc.rev}`)}`);
}

function cmdMove(values, positionals) {
  const store = makeStore(values);
  const { doc: current } = store.read(need(positionals, 0, '导图'));
  const node = resolveNodeRef(current, need(positionals, 1, '节点'));
  const parent = resolveNodeRef(current, need(positionals, 2, '新父节点'));
  const { doc } = store.applyOps(positionals[0], [{ op: 'moveNode', id: node.id, parent: parent.id, position: values.position }], { by: 'cli' });
  console.log(`${c.green('✔')} 已把「${node.text}」移到「${parent.text}」下${c.dim(`  rev ${doc.rev}`)}`);
}

function cmdEdge(values, positionals) {
  const store = makeStore(values);
  const { doc: current } = store.read(need(positionals, 0, '导图'));
  const from = resolveNodeRef(current, need(positionals, 1, '起点'));
  const to = resolveNodeRef(current, need(positionals, 2, '终点'));
  const { doc } = store.applyOps(positionals[0], [{ op: 'addEdge', from: from.id, to: to.id, label: values.label }], { by: 'cli' });
  console.log(`${c.green('✔')} 关联线 ${from.text} → ${to.text}${c.dim(`  rev ${doc.rev}`)}`);
}

async function cmdExport(values, positionals) {
  const store = makeStore(values);
  const map = need(positionals, 0, '导图');
  const format = String(values.format ?? values.out?.split('.').pop() ?? 'png').toLowerCase();
  if (!EXPORT_FORMATS.includes(format)) throw new StoreError(`不支持的格式: ${format}（可用 ${EXPORT_FORMATS.join(', ')}）`, 'invalid_argument');
  const { doc } = store.read(map);
  const outPath = values.out ? path.resolve(values.out) : path.join(store.exportsDir, `${store.read(map).slug}.${format}`);
  const started = Date.now();
  const result = await store.exportMap(map, {
    format,
    path: outPath,
    scale: values.scale ? number(values.scale, undefined) : undefined,
    quality: values.quality ? number(values.quality, undefined) : undefined,
    theme: values.theme,
  });
  console.log(
    `${c.green('✔')} ${c.bold(format.toUpperCase())} ${(result.bytes / 1024).toFixed(1)}KB  ${result.width}x${result.height}  ${Date.now() - started}ms`,
  );
  console.log(`  ${result.path}`);
  console.log(c.dim(`  后端: ${result.engine}`));
  for (const warning of result.warnings ?? []) console.log(c.yellow(`  ! ${warning}`));
  void doc;
}

function cmdImport(values, positionals) {
  const store = makeStore(values);
  const target = need(positionals, 0, '导图名或 new');
  const file = need(positionals, 1, 'Markdown 文件');
  const markdown = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(file), 'utf8');
  const title = values.title ?? guessTitle(markdown) ?? '导入的导图';
  const doc = fromMarkdown(markdown, { title });
  if (target === 'new') {
    const created = store.create({ title: doc.title, by: 'cli' });
    const saved = store.save(created.slug, doc, { by: 'cli', summary: '从 Markdown 导入', force: true });
    console.log(`${c.green('✔')} 已导入为新导图「${saved.doc.title}」 slug=${saved.slug}`);
    return;
  }
  const saved = store.save(target, doc, { by: 'cli', summary: '从 Markdown 覆盖导入', force: true });
  console.log(`${c.green('✔')} 已导入「${saved.doc.title}」 ${docStats(saved.doc).nodes} 节点`);
}

function cmdTemplates(values) {
  const store = makeStore(values);
  const templates = store.templates();
  if (values.json) {
    console.log(JSON.stringify(templates, null, 2));
    return;
  }
  console.log(c.bold('内置模板'));
  for (const item of templates) {
    console.log(`  ${item.emoji} ${c.bold(pad(item.id, 18))} ${item.title.padEnd(8, '　')} ${c.dim(`(${item.nodes} 节点)`)}  ${c.dim(item.description)}`);
  }
  console.log(c.dim('\n用法: mm new "项目规划" --template <id>'));
}

function cmdTag(values, positionals) {
  const store = makeStore(values);
  const map = need(positionals, 0, '导图');
  const { doc } = store.read(map);
  const current = doc.tags ?? [];
  const parse = (raw) => String(raw ?? '').split(/[,，;；]/).map((item) => item.trim()).filter(Boolean);
  const ops = [];

  if (values.clear) ops.push({ op: 'setDoc', tags: [] });
  else if (values.set !== undefined) ops.push({ op: 'setDoc', tags: parse(values.set) });
  else {
    let next = [...current];
    const add = parse(values.add);
    const remove = parse(values.remove).map((item) => item.toLowerCase());
    if (remove.length) next = next.filter((tag) => !remove.includes(tag.toLowerCase()));
    for (const tag of add) if (!next.some((item) => item.toLowerCase() === tag.toLowerCase())) next.push(tag);
    if (add.length || remove.length) ops.push({ op: 'setDoc', tags: next });
  }

  if (!ops.length) {
    console.log(`${c.bold(doc.title)} 的标签：${current.length ? c.blue(current.join('、')) : c.dim('（无）')}`);
    console.log(c.dim('用法: mm tag <导图> --add 论文,第3章 / --remove 论文 / --set a,b / --clear'));
    return;
  }

  const { doc: next } = store.applyOps(map, ops, { by: 'cli' });
  const tags = next.tags ?? [];
  console.log(`${c.green('✔')} 标签已更新：${tags.length ? c.blue(tags.join('、')) : '（无）'}${c.dim(`  rev ${next.rev}`)}`);
}

function cmdFonts(values) {
  if (values.json) {
    console.log(JSON.stringify(FONTS, null, 2));
    return;
  }
  console.log(c.bold('可用字体（都是系统字体，不下载任何东西）'));
  for (const [key, item] of Object.entries(FONTS)) {
    console.log(`  ${c.bold(pad(key, 8))} ${item.label}`);
  }
  console.log(c.dim('\n用法: mm set <导图> <节点> --font kai --font-size 20'));
}

function cmdLog(values, positionals) {
  const store = makeStore(values);
  const map = need(positionals, 0, '导图');
  const { doc, slug } = store.read(map);
  const since = values.since ? number(values.since, 0) : 0;
  const changes = store.changesSince(slug, since);
  if (values.json) {
    console.log(JSON.stringify(changes, null, 2));
    return;
  }
  console.log(c.bold(`${doc.title}`) + c.dim(`  当前 rev ${doc.rev}`));
  if (!changes.journal.length) {
    console.log(c.dim('  （没有更新记录）'));
    return;
  }
  for (const entry of changes.journal) {
    console.log(`  ${c.dim(`rev ${String(entry.rev).padStart(3)}`)} ${c.dim(entry.at.replace('T', ' ').slice(0, 19))} ${c.blue(entry.by.padEnd(6))} ${entry.summary}`);
  }
  if (changes.changedNodes.length) {
    console.log(c.dim('\n节点级差异:'));
    for (const change of changes.changedNodes.slice(0, 40)) {
      if (change.type === 'add') console.log(`  ${c.green('+')} ${change.id}「${change.text}」`);
      else if (change.type === 'remove') console.log(`  ${c.red('-')} ${change.id}「${change.text}」`);
      else if (change.type === 'move') console.log(`  ${c.yellow('>')} ${change.id} ${change.from} → ${change.to}`);
      else console.log(`  ~ ${change.id}.${change.field}: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`);
    }
  }
  console.log(c.dim('\n历史版本:'));
  for (const item of store.history(slug).slice(0, 10)) {
    console.log(`  rev ${item.rev}  ${item.by ?? ''}  ${item.summary ?? ''}`);
  }
}

function cmdRollback(values, positionals) {
  const store = makeStore(values);
  const map = need(positionals, 0, '导图');
  const rev = number(values.rev, NaN);
  if (!Number.isFinite(rev)) throw new StoreError('缺少 --rev', 'invalid_argument');
  const saved = store.rollback(map, rev, { by: 'cli' });
  console.log(`${c.green('✔')} 已回滚到 rev ${rev}，当前 rev ${saved.doc.rev}`);
}

async function cmdOpen(values, positionals) {
  await cmdServe({ ...values, open: true }, positionals);
}

function cmdDoctor(values) {
  const store = makeStore(values);
  const engines = detectEngines();
  const summary = store.summary();
  console.log(c.bold('Mindleaf 环境检查'));
  console.log(`  版本:        ${readVersion()}`);
  console.log(`  Node:        ${process.version} (${process.platform}/${process.arch})`);
  console.log(`  项目目录:    ${summary.projectDir}`);
  console.log(`  配置文件:    ${summary.configPath}`);
  console.log(`  导图目录:    ${summary.mapsDir} ${summary.mapsDirIsAbsolute ? '(绝对路径)' : ''}`);
  console.log(`  工作区根:    ${summary.workspaceDir}`);
  console.log(`  导出目录:    ${summary.exportsDir}`);
  console.log(`  导图数量:    ${summary.maps.length}`);
  console.log('');
  console.log(c.bold('导出能力'));
  console.log(`  无头浏览器:  ${engines.chromium[0] ?? c.yellow('未找到（PDF 会退化为位图；PNG/JPG 需要其它后端）')}`);
  console.log(`  sips:        ${engines.sips ?? c.dim('无')}`);
  console.log(`  rsvg-convert:${engines.rsvg ? ' ' + engines.rsvg : c.dim(' 无')}`);
  console.log(`  inkscape:    ${engines.inkscape ?? c.dim('无')}`);
  console.log(`  qlmanage:    ${engines.qlmanage ?? c.dim('无')}`);
  console.log(`  可导出:      ${EXPORT_FORMATS.join(', ')}`);
  console.log('');
  console.log(c.bold('Agent 接入'));
  console.log(`  DSH / Codex / Claude: 运行 ${c.bold('mm mcp')} 作为 stdio MCP 服务器`);
  console.log(c.dim('  配置示例见 README 的「接入 AI」一节，或 integrations/ 目录'));
}

function cmdConfig(values) {
  const store = makeStore(values);
  if (values['maps-dir']) {
    const config = store.saveConfig({ mapsDir: values['maps-dir'] });
    console.log(`${c.green('✔')} 导图目录已改为 ${c.bold(store.mapsDir)}（已写入 ${store.configPath}）`);
    void config;
    return;
  }
  console.log(JSON.stringify(store.summary(), null, 2));
}

function cmdPath(values, positionals) {
  const store = makeStore(values);
  const { file, slug } = store.read(need(positionals, 0, '导图'));
  console.log(values.json ? JSON.stringify({ slug, file }) : file);
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parse(argv);
  const command = positionals.shift() ?? 'help';
  if (values.help && command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(readVersion());
    return 0;
  }
  switch (command) {
    case 'help':
    case '--help':
      console.log(HELP);
      return 0;
    case 'version':
      console.log(readVersion());
      return 0;
    case 'serve':
    case 'server':
    case 'web':
      await cmdServe(values, positionals);
      return 0;
    case 'open':
      await cmdOpen(values, positionals);
      return 0;
    case 'list':
    case 'ls':
      cmdList(values);
      return 0;
    case 'show':
    case 'cat':
      cmdShow(values, positionals);
      return 0;
    case 'new':
    case 'create':
      cmdNew(values, positionals);
      return 0;
    case 'add':
      cmdAdd(values, positionals);
      return 0;
    case 'set':
    case 'update':
      cmdSet(values, positionals);
      return 0;
    case 'rm':
    case 'remove':
    case 'delete':
      cmdRemove(values, positionals);
      return 0;
    case 'mv':
    case 'move':
      cmdMove(values, positionals);
      return 0;
    case 'edge':
    case 'link':
      cmdEdge(values, positionals);
      return 0;
    case 'export':
      await cmdExport(values, positionals);
      return 0;
    case 'import':
      cmdImport(values, positionals);
      return 0;
    case 'templates':
    case 'template':
      cmdTemplates(values);
      return 0;
    case 'tag':
    case 'tags':
      cmdTag(values, positionals);
      return 0;
    case 'fonts':
    case 'font':
      cmdFonts(values);
      return 0;
    case 'log':
    case 'history':
      cmdLog(values, positionals);
      return 0;
    case 'rollback':
      cmdRollback(values, positionals);
      return 0;
    case 'doctor':
    case 'check':
      cmdDoctor(values);
      return 0;
    case 'config':
      cmdConfig(values);
      return 0;
    case 'path':
      cmdPath(values, positionals);
      return 0;
    case 'mcp': {
      const { runMcpServer } = await import('./mcp/server.mjs');
      await runMcpServer({ project: values.project });
      return 0;
    }
    default:
      console.error(c.red(`未知命令: ${command}`));
      console.log(HELP);
      return 1;
  }
}
