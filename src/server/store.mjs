/**
 * 项目与导图文件存储。
 *
 * 一个"项目"= 一个目录，里面有一份 mindleaf.json 记录配置（导图目录等）。
 * 导图文件是普通 JSON（<slug>.mindmap.json），可以进 git、可以手改、可以被任何 agent 读。
 *
 * 写入策略：
 *  - 原子写（临时文件 + rename），避免 agent 与网页同时写时出现半截文件；
 *  - 同一文件的读改写串行化（进程内锁），rev 冲突时由调用方决定覆盖/合并；
 *  - 每次写入把上一版快照进 .history/，方便回滚和"人类改了什么"的 diff。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DocError,
  createDoc,
  normalizeDoc,
  normalizeTags,
  recordChange,
  rootOf,
  docStats,
  getNode,
} from '../core/doc.mjs';
import { applyOps } from '../core/ops.mjs';
import { safeFileName } from '../export/exporters.mjs';
import { docFromTemplate, listTemplates, getTemplate } from './templates.mjs';

export const CONFIG_FILE = 'mindleaf.json';
export const MAP_EXT = '.mindmap.json';
const HISTORY_LIMIT = 30;

const nowISO = () => new Date().toISOString();

/** 同步 sleep（用于跨进程文件锁的忙等，避免引入异步复杂度）。 */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, Math.max(1, Math.round(ms)));
}

const LOCK_STALE_MS = 10000;
const LOCK_TIMEOUT_MS = 8000;

export class StoreError extends Error {
  constructor(message, code = 'store_error', extra = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** 从 startDir 向上找含 mindleaf.json / .mindleaf 的目录。 */
export function findProjectRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE)) || fs.existsSync(path.join(dir, '.mindleaf'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const slugify = (title, fallback = 'mindmap') => {
  const cleaned = String(title ?? '')
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return cleaned || fallback;
};

export class Store {
  constructor(options = {}) {
    this.projectDir = path.resolve(options.projectDir ?? process.cwd());
    this.configPath = path.join(this.projectDir, CONFIG_FILE);
    this.config = this.#readConfig();
    this.listeners = new Set();
    this.watchers = new Map();
  }

  #readConfig() {
    const fallback = { version: 1, mapsDir: 'maps', exportsDir: 'exports', workspaceDir: null };
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return {
        ...fallback,
        ...raw,
        mapsDir: typeof raw.mapsDir === 'string' && raw.mapsDir.trim() ? raw.mapsDir.trim() : fallback.mapsDir,
        workspaceDir: typeof raw.workspaceDir === 'string' && raw.workspaceDir.trim() ? raw.workspaceDir.trim() : null,
      };
    } catch {
      return fallback;
    }
  }

  /** 保存配置（用于"改导图目录"并记住）。 */
  saveConfig(patch = {}) {
    const next = { ...this.config, ...patch };
    if (typeof patch.mapsDir === 'string' && patch.mapsDir.trim()) {
      const value = patch.mapsDir.trim();
      next.mapsDir = path.isAbsolute(value)
        ? value
        : value.replace(/^\.\//, '');
    }
    fs.mkdirSync(this.projectDir, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    this.config = next;
    this.#ensureDirs();
    this.#restartWatcher();
    return this.config;
  }

  get mapsDir() {
    const value = this.config.mapsDir ?? 'maps';
    return path.isAbsolute(value) ? value : path.join(this.projectDir, value);
  }

  /** 解析相对文件链接所用的工作区根（默认就是项目目录）。 */
  get workspaceDir() {
    const value = this.config.workspaceDir;
    if (!value) return this.projectDir;
    return path.isAbsolute(value) ? value : path.resolve(this.projectDir, value);
  }

  get exportsDir() {
    const value = this.config.exportsDir ?? 'exports';
    return path.isAbsolute(value) ? value : path.join(this.projectDir, value);
  }

  get historyDir() {
    return path.join(this.mapsDir, '.history');
  }

  #ensureDirs() {
    fs.mkdirSync(this.mapsDir, { recursive: true });
    fs.mkdirSync(this.historyDir, { recursive: true });
  }

  init() {
    this.#ensureDirs();
    if (!fs.existsSync(this.configPath)) {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + '\n', 'utf8');
    }
    return this;
  }

  #fileFor(slug) {
    return path.join(this.mapsDir, `${slug}${MAP_EXT}`);
  }

  /** 列出所有导图（读文件头，不加载全量）。可传 { tag } 只看带某个标签的图。 */
  list(options = {}) {
    const tagFilter = typeof options.tag === 'string' && options.tag.trim() ? options.tag.trim().toLowerCase() : null;
    this.#ensureDirs();
    const entries = [];
    let names = [];
    try {
      names = fs.readdirSync(this.mapsDir);
    } catch {
      return entries;
    }
    for (const name of names) {
      if (!name.endsWith(MAP_EXT)) continue;
      const file = path.join(this.mapsDir, name);
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const stats = docStats(normalizeDoc(raw));
        const tags = normalizeTags(raw.tags);
        entries.push({
          slug: name.slice(0, -MAP_EXT.length),
          fileName: name,
          title: raw.title ?? '未命名导图',
          rev: Number.isInteger(raw.rev) ? raw.rev : 0,
          updatedAt: raw.updatedAt ?? null,
          ...stats,
          tags,
          size: fs.statSync(file).size,
        });
      } catch {
        entries.push({ slug: name.slice(0, -MAP_EXT.length), fileName: name, title: name, broken: true, tags: [], rev: 0, nodes: 0, edges: 0, maxDepth: 0 });
      }
    }
    entries.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    if (!tagFilter) return entries;
    return entries.filter((entry) => (entry.tags ?? []).some((tag) => tag.toLowerCase() === tagFilter));
  }

  /** 所有标签及各自出现次数，按次数降序（次数相同按名字）。 */
  tagCounts() {
    const counts = new Map();
    for (const entry of this.list()) {
      for (const tag of entry.tags ?? []) {
        const key = tag.toLowerCase();
        const current = counts.get(key) ?? { tag, count: 0 };
        current.count += 1;
        counts.set(key, current);
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** 把 slug / 文件名 / 绝对路径 解析成真实文件。 */
  resolve(nameOrPath) {
    if (!nameOrPath) throw new StoreError('缺少导图名称', 'invalid_argument');
    const value = String(nameOrPath).trim();
    if (value.endsWith('.json') && (path.isAbsolute(value) || value.includes('/') || value.includes(path.sep))) {
      const file = path.resolve(this.projectDir, value);
      if (fs.existsSync(file)) return { slug: path.basename(file, MAP_EXT).replace(/\.json$/, ''), file };
    }
    const direct = this.#fileFor(value.replace(new RegExp(`${MAP_EXT.replace('.', '\\.')}$`), ''));
    if (fs.existsSync(direct)) {
      return { slug: path.basename(direct, MAP_EXT), file: direct };
    }
    const normalized = slugify(value);
    const viaSlug = this.#fileFor(normalized);
    if (fs.existsSync(viaSlug)) return { slug: normalized, file: viaSlug };
    // 再按标题模糊找
    const hit = this.list().find((entry) => entry.title === value || entry.slug === normalized);
    if (hit) return { slug: hit.slug, file: this.#fileFor(hit.slug) };
    throw new StoreError(`找不到导图: ${nameOrPath}`, 'not_found');
  }

  read(nameOrPath) {
    const { slug, file } = this.resolve(nameOrPath);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new StoreError(`导图文件解析失败: ${file} (${error.message})`, 'invalid_json', { file });
    }
    const doc = normalizeDoc(raw);
    return { doc, slug, file };
  }

  /** 分配一个不冲突的 slug。 */
  #allocateSlug(titleOrSlug) {
    const base = slugify(titleOrSlug ?? 'mindmap');
    let candidate = base;
    let index = 2;
    while (fs.existsSync(this.#fileFor(candidate))) {
      candidate = `${base}-${index}`;
      index += 1;
    }
    return candidate;
  }

  /**
   * 新建导图并落盘。
   * options.template 可以指定内置模板（见 templates/），会用模板内容作为初始结构。
   */
  create(options = {}) {
    this.#ensureDirs();
    const by = options.by ?? 'user';
    let doc;
    let templateInfo = null;
    if (options.template) {
      const built = docFromTemplate(options.template, { title: options.title, rootText: options.rootText });
      if (!built) {
        const available = listTemplates().map((item) => item.id).join(', ');
        throw new StoreError(`未知模板「${options.template}」，可用模板: ${available}`, 'invalid_argument');
      }
      doc = built.doc;
      templateInfo = { id: built.template.id, title: built.template.title };
      if (options.layout) doc.settings.layout = options.layout;
      if (options.theme) doc.settings.theme = options.theme;
      if (options.tags) doc.tags = normalizeTags(options.tags);
      recordChange(doc, { by, action: 'create', summary: `用模板「${built.template.title}」新建导图` });
    } else {
      doc = createDoc({ title: options.title, rootText: options.rootText, theme: options.theme, layout: options.layout, tags: options.tags, by });
      doc.journal[doc.journal.length - 1] = { ...doc.journal[doc.journal.length - 1], summary: `新建导图「${doc.title}」` };
    }
    const slug = this.#allocateSlug(options.slug ?? options.title ?? doc.title);
    doc.id = `mm_${slug}`;
    const file = this.#fileFor(slug);
    this.#writeFile(file, doc);
    this.#emit({ type: 'create', slug, rev: doc.rev, by });
    return { doc, slug, file, template: templateInfo };
  }

  /** 模板列表（给 CLI / 网页 / MCP 用）。 */
  templates() {
    return listTemplates().map(({ markdown, ...rest }) => rest);
  }

  template(idOrTitle) {
    return getTemplate(idOrTitle);
  }

  /**
   * 跨进程文件锁：本工具的写入方可能同时有网页服务、CLI、多个 agent 的 MCP 进程。
   * 用 `O_EXCL` 创建伴生锁文件，临界区只有一次读 + 一次 rename，冲突时短暂重试；
   * 超过 10 秒的锁视为陈旧（进程被 kill 的情况）自动清理。
   */
  #withFileLock(file, fn) {
    const lockPath = `${file}.lock`;
    const startedAt = Date.now();
    let fd = null;
    while (fd === null) {
      try {
        fd = fs.openSync(lockPath, 'wx');
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) fs.rmSync(lockPath, { force: true });
        } catch {
          /* 锁文件刚被释放，继续重试 */
        }
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
          throw new StoreError('导图文件正被其它进程写入，请稍后重试', 'locked', { file });
        }
        sleepSync(8 + Math.random() * 12);
      }
    }
    try {
      fs.writeSync(fd, String(process.pid));
      return fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略 */
      }
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }

  #writeFile(file, doc) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  }

  #snapshot(slug, doc) {
    try {
      const dir = path.join(this.historyDir, slug);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${String(doc.rev).padStart(6, '0')}.json`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
      const snapshots = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
      for (const name of snapshots.slice(0, Math.max(0, snapshots.length - HISTORY_LIMIT))) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    } catch {
      /* 历史快照失败不影响主流程 */
    }
  }

  /**
   * 保存文档（整份替换）。baseRev 用于乐观并发：
   * 若传入 baseRev 且与磁盘 rev 不一致，抛 conflict 并带当前文档。
   */
  save(nameOrPath, doc, options = {}) {
    const { slug, file } = this.resolve(nameOrPath);
    return this.#withFileLock(file, () => {
      const current = this.read(slug);
      if (Number.isInteger(options.baseRev) && options.baseRev !== current.doc.rev && options.force !== true) {
        throw new StoreError('导图已被其它程序修改', 'conflict', { current: current.doc });
      }
      this.#snapshot(slug, current.doc);
      const next = normalizeDoc({
        ...doc,
        id: current.doc.id,
        createdAt: current.doc.createdAt,
        updatedAt: nowISO(),
        rev: current.doc.rev,
        journal: current.doc.journal,
      });
      recordChange(next, {
        by: options.by ?? 'user',
        action: options.action ?? 'edit',
        summary: options.summary ?? summarize(doc, current.doc),
      });
      this.#writeFile(file, next);
      this.#emit({ type: 'save', slug, rev: next.rev, by: options.by ?? 'user' });
      return { doc: next, slug, file };
    });
  }

  /** 应用一批 op（agent 最常用）。 */
  applyOps(nameOrPath, ops, options = {}) {
    const { slug, file } = this.resolve(nameOrPath);
    return this.#withFileLock(file, () => {
      const current = this.read(slug);
      const { doc: next, results } = applyOps(current.doc, ops);
      this.#snapshot(slug, current.doc);
      recordChange(next, {
        by: options.by ?? 'agent',
        action: options.action ?? 'ops',
        summary: options.summary ?? describeOps(ops, next),
      });
      this.#writeFile(file, next);
      this.#emit({ type: 'ops', slug, rev: next.rev, by: options.by ?? 'agent' });
      return { doc: next, results, slug, file };
    });
  }

  /** 节点级快捷写入（MCP 单点修改用）。 */
  patchNode(nameOrPath, nodeId, patch, options = {}) {
    return this.applyOps(nameOrPath, [{ op: 'updateNode', id: nodeId, ...patch }], options);
  }

  addNode(nameOrPath, patch, options = {}) {
    return this.applyOps(nameOrPath, [{ op: 'addNode', ...patch }], options);
  }

  removeNode(nameOrPath, nodeId, options = {}) {
    return this.applyOps(nameOrPath, [{ op: 'removeNode', id: nodeId }], options);
  }

  delete(nameOrPath) {
    const { slug, file } = this.resolve(nameOrPath);
    return this.#withFileLock(file, () => {
      fs.rmSync(file, { force: true });
      fs.rmSync(path.join(this.historyDir, slug), { recursive: true, force: true });
      this.#emit({ type: 'delete', slug });
      return { slug, deleted: true };
    });
  }

  /** 历史版本列表。 */
  history(nameOrPath) {
    const { slug } = this.resolve(nameOrPath);
    const dir = path.join(this.historyDir, slug);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => {
        const file = path.join(dir, name);
        try {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
          return {
            rev: raw.rev,
            at: raw.updatedAt,
            title: raw.title,
            nodes: raw.nodes?.length ?? 0,
            by: raw.journal?.at(-1)?.by ?? 'unknown',
            summary: raw.journal?.at(-1)?.summary ?? '',
            file,
          };
        } catch {
          return { rev: Number(name.replace('.json', '')), file, broken: true };
        }
      })
      .reverse();
  }

  /** 回滚到某个历史 rev。 */
  rollback(nameOrPath, rev, options = {}) {
    const { slug } = this.resolve(nameOrPath);
    const entry = this.history(slug).find((item) => item.rev === rev);
    if (!entry) throw new StoreError(`没有找到历史版本 rev=${rev}`, 'not_found');
    const raw = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
    return this.save(slug, raw, { ...options, summary: options.summary ?? `回滚到 rev ${rev}` });
  }

  /**
   * 某 rev 之后发生了什么（agent 用来了解人类的最新改动）。
   * 快照只保留最近 N 版：若 sinceRev 比最老快照还早，就用最老快照当基准，并在 baseRev 里说明。
   */
  changesSince(nameOrPath, sinceRev = 0) {
    const { doc } = this.read(nameOrPath);
    const journal = (doc.journal ?? []).filter((entry) => entry.rev > sinceRev);
    let changedNodes = [];
    let baseRev = null;
    if (journal.length) {
      const snapshots = this.history(nameOrPath);
      const atOrBefore = snapshots.find((item) => item.rev <= sinceRev);
      const base = atOrBefore ?? snapshots[snapshots.length - 1] ?? null;
      if (base) {
        try {
          const before = normalizeDoc(JSON.parse(fs.readFileSync(base.file, 'utf8')));
          changedNodes = diffNodes(before, doc);
          baseRev = before.rev;
        } catch {
          /* 忽略 */
        }
      }
    }
    return { rev: doc.rev, sinceRev, baseRev, journal, changedNodes };
  }

  /** 导出：写到 exports/ 或指定路径。 */
  async exportMap(nameOrPath, options = {}) {
    const { exportDoc, safeFileName: safe } = await import('../export/exporters.mjs');
    const { doc, slug } = this.read(nameOrPath);
    const format = String(options.format ?? 'png').toLowerCase();
    const fileName = `${safe(options.name ?? doc.title ?? slug, slug)}.${format === 'markdown' ? 'md' : format}`;
    const outPath = options.path
      ? path.resolve(this.projectDir, options.path)
      : path.join(this.exportsDir, fileName);
    const result = await exportDoc(doc, { ...options, format, outPath, projectRoot: this.workspaceDir, scale: options.scale });
    this.#emit({ type: 'export', slug, format, path: result.path });
    return result;
  }

  /** 订阅变更（HTTP SSE / CLI watch 用）。 */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit(event) {
    const payload = { ...event, at: nowISO() };
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch {
        /* 忽略订阅者异常 */
      }
    }
  }

  /** 监听导图目录，让网页能感知"别的程序改了文件"。 */
  watch() {
    this.#restartWatcher();
    return this;
  }

  #restartWatcher() {
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        /* 忽略 */
      }
    }
    this.watchers.clear();
    this.#ensureDirs();
    try {
      const watcher = fs.watch(this.mapsDir, { persistent: false }, (_eventType, fileName) => {
        const name = String(fileName ?? '');
        if (!name.endsWith(MAP_EXT)) return;
        const slug = name.slice(0, -MAP_EXT.length);
        this.#emit({ type: 'external', slug });
      });
      watcher.on('error', () => undefined);
      this.watchers.set('maps', watcher);
    } catch {
      /* 某些平台/目录不支持 watch，退化为轮询由前端负责 */
    }
  }

  summary() {
    return {
      projectDir: this.projectDir,
      configPath: this.configPath,
      mapsDir: this.mapsDir,
      exportsDir: this.exportsDir,
      workspaceDir: this.workspaceDir,
      mapsDirIsAbsolute: path.isAbsolute(this.config.mapsDir ?? ''),
      relativeMapsDir: path.relative(this.projectDir, this.mapsDir) || '.',
      maps: this.list(),
      tags: this.tagCounts(),
    };
  }

  node(nameOrPath, nodeId) {
    const { doc } = this.read(nameOrPath);
    const node = getNode(doc, nodeId) ?? getNode(doc, rootOf(doc).id);
    if (!node) throw new StoreError(`节点不存在: ${nodeId}`, 'not_found');
    return node;
  }
}

/** 粗略描述一次保存改了什么（写进 journal 给人看）。 */
function summarize(next, before) {
  const parts = [];
  if (next.title !== before.title) parts.push(`标题「${before.title}」→「${next.title}」`);
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
  const added = [...nextNodes.keys()].filter((id) => !beforeNodes.has(id)).length;
  const removed = [...beforeNodes.keys()].filter((id) => !nextNodes.has(id)).length;
  let updated = 0;
  for (const [id, node] of nextNodes) {
    const old = beforeNodes.get(id);
    if (!old) continue;
    if (old.text !== node.text || old.note !== node.note || old.parent !== node.parent || JSON.stringify(old.links) !== JSON.stringify(node.links)) updated += 1;
  }
  if (added) parts.push(`新增 ${added} 个节点`);
  if (removed) parts.push(`删除 ${removed} 个节点`);
  if (updated) parts.push(`修改 ${updated} 个节点`);
  if (next.settings?.layout !== before.settings?.layout) parts.push(`布局 ${before.settings?.layout} → ${next.settings?.layout}`);
  if ((next.tags ?? []).join(',') !== (before.tags ?? []).join(',')) {
    const tags = next.tags ?? [];
    parts.push(tags.length ? `标签改成 ${tags.join('、')}` : '清空标签');
  }
  return parts.join('，') || '内容更新';
}

function describeOps(ops, doc) {
  const counts = new Map();
  for (const op of ops) {
    const name = op.op ?? op.type ?? 'op';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const labels = {
    addNode: '新增节点',
    addChildren: '批量新增子节点',
    updateNode: '修改节点',
    removeNode: '删除节点',
    moveNode: '移动节点',
    reorderNode: '调整顺序',
    addEdge: '新增关联线',
    updateEdge: '修改关联线',
    removeEdge: '删除关联线',
    setDoc: '调整文档设置',
  };
  const text = [...counts.entries()].map(([name, count]) => `${labels[name] ?? name}${count > 1 ? ` x${count}` : ''}`).join('，');

  // 只有单个 addNode 时，把文字写进 summary，人读起来更直观
  if (ops.length === 1 && (ops[0].op === 'addNode' || ops[0].type === 'addNode') && ops[0].text) {
    const node = doc.nodes.find((item) => item.text === ops[0].text);
    return `新增节点「${ops[0].text}」${node ? ` (${node.id})` : ''}`;
  }
  // setDoc 单独出现时，写清楚改的是标题 / 布局 / 主题 / 标签
  const setDocs = ops.filter((op) => (op.op ?? op.type) === 'setDoc');
  if (setDocs.length === ops.length) {
    const parts = [];
    for (const op of setDocs) {
      if (typeof op.title === 'string' && op.title.trim()) parts.push(`标题改成「${op.title.trim()}」`);
      if (op.layout) parts.push(`布局改成 ${op.layout}`);
      if (op.theme) parts.push(`主题改成 ${op.theme}`);
      if (Object.prototype.hasOwnProperty.call(op, 'tags')) {
        const tags = doc.tags ?? [];
        parts.push(tags.length ? `标签改成 ${tags.join('、')}` : '清空标签');
      }
    }
    if (parts.length) return parts.join('，');
  }
  return text || '更新';
}

/** 两个版本的节点级 diff。 */
export function diffNodes(before, after) {
  const changes = [];
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  for (const [id, node] of afterNodes) {
    const old = beforeNodes.get(id);
    if (!old) {
      changes.push({ type: 'add', id, text: node.text });
      continue;
    }
    if (old.text !== node.text) changes.push({ type: 'update', id, field: 'text', from: old.text, to: node.text });
    if ((old.note ?? '') !== (node.note ?? '')) changes.push({ type: 'update', id, field: 'note', from: old.note, to: node.note });
    if (old.parent !== node.parent) changes.push({ type: 'move', id, text: node.text, from: old.parent, to: node.parent });
    if (old.collapsed !== node.collapsed) changes.push({ type: 'update', id, field: 'collapsed', to: node.collapsed });
    if (JSON.stringify(old.links ?? []) !== JSON.stringify(node.links ?? [])) changes.push({ type: 'update', id, field: 'links', to: node.links });
  }
  for (const [id, node] of beforeNodes) {
    if (!afterNodes.has(id)) changes.push({ type: 'remove', id, text: node.text });
  }
  return changes;
}

export { DocError, applyOps, safeFileName };
