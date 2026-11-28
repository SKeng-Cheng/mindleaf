/**
 * HTTP 服务：网页 UI + JSON API，零依赖（node:http）。
 *
 * 网页和 CLI/MCP 都走同一个 Store，所以"人在网页上改"和"agent 在命令行改"
 * 看到的是同一份文件、同一套语义；SSE 负责把外部改动推给已打开的页面。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, StoreError } from './store.mjs';
import { accessEntries } from './access.mjs';
import { handleDav } from './dav.mjs';
import { fromMarkdown, guessTitle, toMarkdown } from '../core/markdown.mjs';
import { outline, normalizeDoc, docStats, eachNode, rootOf } from '../core/doc.mjs';
import { EXPORT_FORMATS } from '../export/exporters.mjs';
import { detectEngines } from '../export/raster.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const WEB_DIR = path.join(ROOT, 'web');
const CORE_DIR = path.join(HERE, '..', 'core');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MAX_BODY = 8 * 1024 * 1024;
/** 单张截图上限。 */
const MAX_IMAGE = 12 * 1024 * 1024;

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

const fail = (res, status, code, message, extra = {}) => json(res, status, { error: code, message, ...extra });

/** 读原始二进制（贴图上传用），超过 max 字节直接拒绝。 */
function readBinary(req, max = MAX_IMAGE) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new StoreError(`图片太大（上限 ${Math.round(max / 1024 / 1024)} MB）`, 'too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new StoreError('请求体过大', 'too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new StoreError('请求体不是合法 JSON', 'invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function safeJoin(baseDir, relative) {
  const resolved = path.resolve(baseDir, '.' + path.posix.normalize('/' + relative));
  if (!resolved.startsWith(path.resolve(baseDir))) return null;
  return resolved;
}

function serveFile(res, file, options = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    fail(res, 404, 'not_found', `文件不存在: ${path.basename(file)}`);
    return;
  }
  if (!stat.isFile()) {
    fail(res, 404, 'not_found', '不是文件');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const headers = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': options.noCache ? 'no-store' : 'no-cache',
  };
  if (options.download) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(path.basename(file))}"`;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

/** 有导图的 workspace 根：用于把相对路径链接解析成真实文件。 */
function workspaceRootFor(store) {
  return store.workspaceDir ?? store.projectDir;
}

/* ---------------- 访问口令（token） ---------------- */

const TOKEN_COOKIE = 'mindleaf_token';
const TOKEN_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 天

/** 从 query / 请求头 / cookie 里取口令。 */
export function tokenFromRequest(req, url) {
  const fromQuery = url?.searchParams?.get('t');
  if (fromQuery) return fromQuery.trim();
  const header = req.headers['x-mindleaf-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const cookie = req.headers.cookie;
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [key, ...rest] = part.trim().split('=');
      if (key === TOKEN_COOKIE) return decodeURIComponent(rest.join('='));
    }
  }
  return '';
}

/** 口令不对时给的页面：一个输入框，提交后带上 ?t=。 */
function tokenPage(needForm) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Mindleaf · 需要口令</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{margin:0;height:100%;background:#0f172a;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  main{max-width:360px;margin:0 auto;padding:22vh 24px}
  h1{font-size:17px;margin:0 0 6px}
  p{color:#8fa3ba;font-size:13px;line-height:1.6;margin:0 0 18px}
  form{display:flex;gap:8px}
  input{flex:1;height:38px;padding:0 12px;border-radius:9px;border:1px solid #2b4670;background:#141f33;color:#e6edf3;font-size:14px}
  button{height:38px;padding:0 16px;border:0;border-radius:9px;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
</style></head><body><main>
<h1>这张导图需要访问口令</h1>
<p>向分享者要一下网址里的 <code>?t=</code> 后面的口令，或者在下面填进来。</p>
${needForm ? '<form method="get" action="/"><input name="t" placeholder="访问口令" autocomplete="off" autofocus><button type="submit">进入</button></form>' : ''}
</main></body></html>`;
}

export async function createApp(options = {}) {
  const store = options.store ?? new Store({ projectDir: options.projectDir }).init();
  store.watch();
  const engines = options.engines ?? detectEngines();
  const clients = new Set();
  const notifyClients = () => options.onClientsChange?.(clients.size);
  const unsubscribe = store.subscribe((event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  });

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  /** 当前服务的访问入口（给网页顶栏的「分享」按钮用）。 */
  const accessInfo = () => {
    const port = server?.address()?.port ?? 0;
    if (!port) return { local: '', lan: null, same: true };
    const host = options.host ?? '127.0.0.1';
    return accessEntries({ port, listenHost: host, token: options.token ?? '' });
  };

  const state = () => {
    const access = accessInfo();
    const base = (access.lan || access.local || '').replace(/\/\?.*$/, '');
    return {
      ...store.summary(),
      access,
      // 网盘挂载入口：给 docx/pptx/pdf 这类"浏览器里改不了"的文件用本机 Office 编辑
      dav: base ? { url: `${base}/dav/`, user: 'mindleaf', token: options.token ?? '' } : null,
      engines: {
        chromium: engines.chromium.length > 0,
        chromiumPath: engines.chromium[0] ?? null,
        png: engines.png,
        pdf: engines.pdf,
      },
      formats: EXPORT_FORMATS,
      version: readVersion(),
    };
  };

  route('GET', /^\/api\/health$/, (req, res) => json(res, 200, { ok: true, uptime: process.uptime() }));
  // 主动关闭服务（`mm stop` 走这里，比直接 kill 干净）
  route('POST', /^\/api\/shutdown$/, (req, res) => {
    json(res, 200, { ok: true, message: '正在关闭' });
    setTimeout(() => options.onShutdownRequest?.(), 10);
  });
  route('GET', /^\/api\/state$/, (req, res) => json(res, 200, state()));
  route('GET', /^\/api\/config$/, (req, res) => json(res, 200, { config: store.config, summary: store.summary() }));
  route('PUT', /^\/api\/config$/, async (req, res) => {
    const body = await readBody(req);
    const config = store.saveConfig({ mapsDir: body.mapsDir });
    json(res, 200, { config, summary: store.summary() });
  });

  route('GET', /^\/api\/templates$/, (req, res) => json(res, 200, { templates: store.templates() }));
  route('GET', /^\/api\/templates\/([^/]+)$/, (req, res, params) => {
    const template = store.template(decodeURIComponent(params[0]));
    if (!template) return fail(res, 404, 'not_found', `未知模板: ${params[0]}`);
    json(res, 200, { template });
  });
  route('GET', /^\/api\/tags$/, (req, res) => json(res, 200, { tags: store.tagCounts() }));
  route('GET', /^\/api\/maps$/, (req, res, params, url) =>
    json(res, 200, { maps: store.list({ tag: url.searchParams.get('tag') ?? undefined }) }),
  );
  route('POST', /^\/api\/maps$/, async (req, res) => {
    const body = await readBody(req);
    const created = store.create({
      title: body.title,
      rootText: body.rootText,
      template: body.template,
      layout: body.layout,
      theme: body.theme,
      tags: body.tags,
      by: body.by ?? 'user',
    });
    json(res, 201, created);
  });
  route('GET', /^\/api\/maps\/([^/]+)$/, (req, res, params) => {
    const map = store.read(decodeURIComponent(params[0]));
    json(res, 200, {
      ...map,
      stats: docStats(map.doc),
      outline: outline(map.doc),
      history: store.history(map.slug).slice(0, 10),
      markdown: toMarkdown(map.doc),
    });
  });
  route('PUT', /^\/api\/maps\/([^/]+)$/, async (req, res, params) => {
    const body = await readBody(req);
    if (!body.doc) throw new StoreError('缺少 doc 字段', 'invalid_argument');
    const saved = store.save(decodeURIComponent(params[0]), body.doc, {
      baseRev: body.baseRev,
      by: body.by ?? 'user',
      summary: body.summary,
      force: body.force === true,
    });
    json(res, 200, saved);
  });
  // 上传一张附图（原始二进制 body，content-type 决定扩展名）
  route('POST', /^\/api\/maps\/([^/]+)\/images$/, async (req, res, params) => {
    const slug = decodeURIComponent(params[0]);
    store.read(slug); // 确认导图存在
    const buffer = await readBinary(req);
    if (!buffer.length) throw new StoreError('图片内容为空', 'invalid_argument');
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : type === 'image/gif' ? 'gif' : 'png';
    const saved = store.saveImage(slug, buffer, ext);
    json(res, 200, { path: saved.path, bytes: saved.bytes });
  });

  // 取附图（只允许项目目录内的相对路径）
  route('GET', /^\/api\/assets$/, (req, res, params, url) => {
    const target = url.searchParams.get('path') ?? '';
    const file = store.resolveImage(target);
    if (!file) return fail(res, 404, 'not_found', `图片不存在: ${target}`);
    serveFile(res, file);
  });

  route('POST', /^\/api\/maps\/([^/]+)\/ops$/, async (req, res, params) => {
    const body = await readBody(req);
    const result = store.applyOps(decodeURIComponent(params[0]), body.ops ?? [], { by: body.by ?? 'agent', summary: body.summary });
    json(res, 200, result);
  });
  route('DELETE', /^\/api\/maps\/([^/]+)$/, (req, res, params) => {
    json(res, 200, store.delete(decodeURIComponent(params[0])));
  });
  route('GET', /^\/api\/maps\/([^/]+)\/history$/, (req, res, params) => {
    const map = store.read(decodeURIComponent(params[0]));
    json(res, 200, { history: store.history(map.slug) });
  });
  route('POST', /^\/api\/maps\/([^/]+)\/rollback$/, async (req, res, params) => {
    const body = await readBody(req);
    const result = store.rollback(decodeURIComponent(params[0]), Number(body.rev), { by: body.by ?? 'user' });
    json(res, 200, result);
  });
  route('GET', /^\/api\/maps\/([^/]+)\/changes$/, (req, res, params, url) => {
    const since = Number(url.searchParams.get('since') ?? 0);
    json(res, 200, store.changesSince(decodeURIComponent(params[0]), since));
  });
  route('POST', /^\/api\/maps\/([^/]+)\/import$/, async (req, res, params) => {
    const body = await readBody(req);
    const slug = decodeURIComponent(params[0]);
    let doc;
    if (typeof body.markdown === 'string') {
      doc = fromMarkdown(body.markdown, { title: body.title ?? guessTitle(body.markdown) ?? undefined });
    } else if (body.doc) {
      doc = normalizeDoc(body.doc);
    } else {
      throw new StoreError('缺少 markdown 或 doc 字段', 'invalid_argument');
    }
    if (typeof body.title === 'string' && body.title.trim()) doc.title = body.title.trim();
    const saved = store.save(slug === 'new' ? store.create({ title: doc.title }).slug : slug, doc, {
      by: body.by ?? 'user',
      summary: body.summary ?? '导入内容',
      force: true,
    });
    json(res, 200, saved);
  });
  route('POST', /^\/api\/maps\/([^/]+)\/export$/, async (req, res, params) => {
    const body = await readBody(req);
    const slug = decodeURIComponent(params[0]);
    const format = String(body.format ?? 'png').toLowerCase();
    if (body.to === 'disk') {
      const result = await store.exportMap(slug, { format, scale: body.scale, quality: body.quality, theme: body.theme, name: body.name });
      json(res, 200, { ...result, path: path.relative(store.projectDir, result.path) });
      return;
    }
    // 直接回二进制，浏览器用 <a download> 拿；临时文件放系统临时目录，别污染项目
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindleaf-download-'));
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `export-${Date.now()}.${format}`);
    try {
      const result = await store.exportMap(slug, { format, scale: body.scale, quality: body.quality, theme: body.theme, name: body.name, path: tmpFile });
      serveFile(res, result.path, { download: true, noCache: true });
    } finally {
      setTimeout(() => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* 忽略 */
        }
      }, 5000);
    }
  });
  route('GET', /^\/api\/events$/, (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`: connected\n\n`);
    clients.add(res);
    notifyClients();
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping);
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
      notifyClients();
    });
  });
  // 文件/代码链接预览：只允许读项目目录内的文件
  /* ---------------- 分享文件 ---------------- */

  // 清单（带磁盘状态）
  route('GET', /^\/api\/shared$/, (req, res, params, url) => {
    const slug = url.searchParams.get('map');
    if (!slug) throw new StoreError('缺少 map 参数', 'invalid_argument');
    json(res, 200, { files: store.sharedFiles(decodeURIComponent(slug)) });
  });

  // 原始文件（图片 / PDF / Office 都直接给浏览器或下载器）
  route('GET', /^\/api\/shared\/raw$/, (req, res, params, url) => {
    const slug = url.searchParams.get('map');
    const id = url.searchParams.get('id');
    const { info } = store.needSharedFile(decodeURIComponent(slug ?? ''), id ?? '');
    serveFile(res, info.abs, { noCache: true, download: url.searchParams.get('download') === '1' });
  });

  // 文本内容（给内置编辑器）
  route('GET', /^\/api\/shared\/text$/, (req, res, params, url) => {
    const slug = url.searchParams.get('map');
    const id = url.searchParams.get('id');
    const data = store.readSharedText(decodeURIComponent(slug ?? ''), id ?? '');
    json(res, 200, { id: data.id, path: data.path, label: data.label ?? null, mode: data.mode, size: data.size, mtime: data.mtime, content: data.content });
  });

  // 写回文本
  route('PUT', /^\/api\/shared\/text$/, async (req, res) => {
    const body = await readBody(req);
    const saved = store.writeSharedText(decodeURIComponent(body.map ?? ''), body.id ?? '', body.content ?? '', Number(body.mtime));
    json(res, 200, { ok: true, file: saved });
  });

  // Office / PDF 的预览图（qlmanage 生成，缓存在 .mindleaf/previews）
  route('GET', /^\/api\/shared\/preview$/, async (req, res, params, url) => {
    const slug = url.searchParams.get('map');
    const id = url.searchParams.get('id');
    const { png } = await store.previewSharedFile(decodeURIComponent(slug ?? ''), id ?? '');
    serveFile(res, png, { noCache: false });
  });

  // 浏览工作区目录（添加分享文件时用）
  route('GET', /^\/api\/shared\/browse$/, (req, res, params, url) => {
    const root = store.workspaceDir ?? store.projectDir;
    const rel = String(url.searchParams.get('dir') ?? '').replace(/\\/g, '/');
    if (rel.split('/').includes('..') || rel.startsWith('/')) throw new StoreError('非法目录', 'invalid_argument');
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(path.resolve(root) + path.sep)) throw new StoreError('非法目录', 'invalid_argument');
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new StoreError(`目录不存在: ${rel || '.'}`, 'not_found');
    }
    if (!stat.isDirectory()) throw new StoreError('不是目录', 'invalid_argument');
    const IGNORE = new Set(['.git', 'node_modules', '.mindleaf', '.history', 'dist', 'exports']);
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((entry) => !IGNORE.has(entry.name) && !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        dir: entry.isDirectory(),
        size: entry.isFile() ? safeSize(path.join(abs, entry.name)) : 0,
      }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      .slice(0, 500);
    json(res, 200, { dir: rel, path: rel ? `${path.relative(root, abs).split(path.sep).join('/')}` : '', entries });
  });

  // 添加 / 移除分享文件
  route('POST', /^\/api\/shared$/, async (req, res) => {
    const body = await readBody(req);
    const slug = decodeURIComponent(body.map ?? '');
    const ops = [];
    if (body.action === 'add') {
      const { doc } = store.read(slug);
      const info = store.describeSharedFile({ path: String(body.path ?? ''), mode: body.mode === 'rw' ? 'rw' : 'ro' });
      if (!info.exists) throw new StoreError(`文件不存在: ${body.path}`, 'not_found');
      if ((doc.sharedFiles ?? []).some((item) => item.path === info.path)) {
        throw new StoreError('这个文件已经在分享清单里了', 'duplicate');
      }
      ops.push({ op: 'addSharedFile', path: info.path, label: body.label, mode: body.mode === 'rw' ? 'rw' : 'ro' });
    } else if (body.action === 'remove') {
      ops.push({ op: 'removeSharedFile', id: body.id });
    } else if (body.action === 'mode') {
      ops.push({ op: 'updateSharedFile', id: body.id, mode: body.mode === 'rw' ? 'rw' : 'ro' });
    } else {
      throw new StoreError('未知操作', 'invalid_argument');
    }
    const result = store.applyOps(slug, ops, { by: body.by ?? 'user', summary: body.action === 'add' ? '分享文件' : body.action === 'remove' ? '取消分享' : '修改分享权限' });
    json(res, 200, { ok: true, result: result.results, files: store.sharedFiles(slug) });
  });

  route('GET', /^\/api\/file$/, (req, res, params, url) => {
    const target = url.searchParams.get('path') ?? '';
    if (!target) throw new StoreError('缺少 path 参数', 'invalid_argument');
    const root = workspaceRootFor(store);
    const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
    const stat = (() => {
      try {
        return fs.statSync(resolved);
      } catch {
        return null;
      }
    })();
    if (!stat) return fail(res, 404, 'not_found', `文件不存在: ${target}`);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved, { withFileTypes: true }).slice(0, 200).map((entry) => ({
        name: entry.name,
        dir: entry.isDirectory(),
        size: entry.isFile() ? safeSize(path.join(resolved, entry.name)) : 0,
      }));
      return json(res, 200, { kind: 'dir', path: resolved, entries });
    }
    if (stat.size > 400 * 1024) return json(res, 200, { kind: 'binary', path: resolved, size: stat.size, message: '文件较大，未预览' });
    const buffer = fs.readFileSync(resolved);
    if (buffer.subarray(0, 8000).includes(0)) {
      return json(res, 200, { kind: 'binary', path: resolved, size: stat.size, message: '二进制文件，未预览' });
    }
    const relative = path.relative(root, resolved);
    return json(res, 200, {
      kind: 'text',
      path: resolved,
      relative: relative.startsWith('..') ? resolved : relative,
      size: stat.size,
      content: buffer.toString('utf8'),
    });
  });
  route('POST', /^\/api\/reveal$/, async (req, res) => {
    const body = await readBody(req);
    const root = workspaceRootFor(store);
    const resolved = path.isAbsolute(body.path) ? body.path : path.resolve(root, body.path);
    if (!fs.existsSync(resolved)) return fail(res, 404, 'not_found', '路径不存在');
    const { spawn } = await import('node:child_process');
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    const args = process.platform === 'darwin' ? ['-R', resolved] : [path.dirname(resolved)];
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    json(res, 200, { ok: true });
  });
  route('GET', /^\/api\/logs$/, (req, res, params, url) => {
    const since = Number(url.searchParams.get('since') ?? 0);
    const slug = url.searchParams.get('map');
    if (!slug) return json(res, 200, { journal: [] });
    const { doc } = store.read(slug);
    json(res, 200, { rev: doc.rev, journal: (doc.journal ?? []).filter((entry) => entry.rev >= since) });
  });

  function safeSize(file) {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  const requiredToken = typeof options.token === 'string' && options.token.trim() ? options.token.trim() : '';
  /** WebDAV 的"名义锁"，只为让 Office 的保存流程顺畅。 */
  const davLocks = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = decodeURIComponent(url.pathname);
    res.setHeader('x-mindleaf', '1');

    // WebDAV：给 Finder / 资源管理器挂载用（Basic 口令 = 访问口令）。
    // 判断用**原始**路径：反向规范化会吃掉 %2e%2e，导致穿越检查失效。
    const rawPath = String(req.url ?? '/').split('?')[0];
    if (rawPath === '/dav' || rawPath.startsWith('/dav/')) {
      const basic = (() => {
        const raw = req.headers.authorization ?? '';
        if (!raw.toLowerCase().startsWith('basic ')) return '';
        try {
          const decoded = Buffer.from(raw.slice(6), 'base64').toString('utf8');
          return decoded.slice(decoded.indexOf(':') + 1);
        } catch {
          return '';
        }
      })();
      const provided = tokenFromRequest(req, url) || basic || (req.headers.authorization ?? '').replace(/^Basic /i, '');
      if (requiredToken && provided !== requiredToken) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="Mindleaf", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
        res.end('需要访问口令（Basic 认证：用户名随意，密码是口令）');
        return;
      }
      await handleDav({ req, res, store, locks: davLocks, rawPath });
      return;
    }

    // 口令校验：只放行健康检查（用于判断服务是否起来），其余一律要口令
    if (requiredToken && pathname !== '/api/health') {
      const provided = tokenFromRequest(req, url);
      if (provided !== requiredToken) {
        if (pathname.startsWith('/api/')) {
          fail(res, 401, 'unauthorized', '需要访问口令（网址里的 ?t=…）');
          return;
        }
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(tokenPage(true));
        return;
      }
      // 口令对：种一个 cookie，之后页面里的 fetch / SSE 自动带上，不用改前端代码
      if (url.searchParams.get('t')) {
        res.setHeader('set-cookie', `${TOKEN_COOKIE}=${encodeURIComponent(requiredToken)}; Path=/; Max-Age=${TOKEN_COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly`);
      }
    }

    try {
      if (pathname.startsWith('/api/')) {
        for (const item of routes) {
          if (item.method !== req.method) continue;
          const match = item.pattern.exec(pathname);
          if (!match) continue;
          await item.handler(req, res, match.slice(1), url);
          return;
        }
        fail(res, 404, 'not_found', `未知接口: ${req.method} ${pathname}`);
        return;
      }
      // 静态资源
      if (pathname === '/' || pathname === '/index.html') {
        serveFile(res, path.join(WEB_DIR, 'index.html'), { noCache: true });
        return;
      }
      if (pathname.startsWith('/src/core/')) {
        const file = safeJoin(CORE_DIR, pathname.slice('/src/core/'.length));
        if (!file) return fail(res, 403, 'forbidden', '非法路径');
        serveFile(res, file, { noCache: true });
        return;
      }
      const webFile = safeJoin(WEB_DIR, pathname.slice(1));
      if (webFile && fs.existsSync(webFile)) {
        serveFile(res, webFile, { noCache: true });
        return;
      }
      fail(res, 404, 'not_found', `找不到 ${pathname}`);
    } catch (error) {
      if (error instanceof StoreError) {
        const status =
          error.code === 'not_found' ? 404
            : error.code === 'conflict' || error.code === 'duplicate' ? 409
              : error.code === 'forbidden' ? 403
                : error.code === 'unsupported' ? 501
                  : 400;
        fail(res, status, error.code, error.message, error.current ? { current: error.current } : {});
        return;
      }
      fail(res, 500, 'internal_error', error?.message ?? String(error));
    }
  });

  server.on('close', () => {
    unsubscribe();
    for (const client of clients) {
      try {
        client.end();
      } catch {
        /* 忽略 */
      }
    }
    clients.clear();
  });

  return {
    server,
    store,
    engines,
    state,
    clientCount: () => clients.size,
    closeClients: () => {
      for (const client of clients) {
        try {
          client.end();
        } catch {
          /* 忽略 */
        }
      }
      clients.clear();
    },
  };
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 启动服务。
 * @param {{projectDir?:string, port?:number, host?:string, store?:Store}} options
 */
export async function startServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const requested = Number.isInteger(options.port) ? options.port : 7788;
  const idleExitMs = Number.isFinite(options.idleExitMs) ? options.idleExitMs : 0;
  const firstPageTimeoutMs = Number.isFinite(options.firstPageTimeoutMs) ? options.firstPageTimeoutMs : 0;

  let idleTimer = null;
  let firstPageTimer = null;
  let closed = false;
  let sawClient = false;
  let resolveExited = () => {};
  /** 自动退出（页面全关）或手动关闭时 resolve */
  const exited = new Promise((resolve) => {
    resolveExited = resolve;
  });

  let resolveServerClosed = () => {};
  const serverClosed = new Promise((resolve) => {
    resolveServerClosed = resolve;
  });

  /** 收尾：不再接受连接、断开 SSE、通知等待者（可重复调用） */
  const shutdown = () => {
    closeHttpServer();
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    clearTimeout(firstPageTimer);
    resolveExited();
    options.onAutoExit?.();
  };

  function closeHttpServer() {
    try {
      app.server.close(() => resolveServerClosed());
      app.server.closeAllConnections?.();
    } catch {
      resolveServerClosed();
    }
  }

  const handleClientsChange = (count) => {
    options.onClientsChange?.(count);
    if (count > 0) {
      sawClient = true;
      clearTimeout(idleTimer);
      clearTimeout(firstPageTimer);
      firstPageTimer = null;
      return;
    }
    // 曾经有页面连过，现在全关了 → 等一小会儿再退（留出刷新 / 重连的时间）
    if (sawClient && idleExitMs && !closed) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(shutdown, idleExitMs);
    }
  };

  const app = await createApp({
    ...options,
    token: options.token,
    onClientsChange: handleClientsChange,
    // /api/shutdown 走同一条收尾路径
    onShutdownRequest: () => shutdown(),
  });
  if (firstPageTimeoutMs && !sawClient) {
    firstPageTimer = setTimeout(() => {
      if (!sawClient) shutdown();
    }, firstPageTimeoutMs);
  }

  const port = await new Promise((resolve, reject) => {
    const tryListen = (candidate, attempt = 0) => {
      const onError = (error) => {
        if (error.code === 'EADDRINUSE' && attempt < 20) {
          tryListen(candidate + 1, attempt + 1);
          return;
        }
        reject(error);
      };
      app.server.once('error', onError);
      app.server.listen(candidate, host, () => {
        app.server.off('error', onError);
        resolve(candidate);
      });
    };
    tryListen(requested);
  });
  const actualPort = app.server.address()?.port ?? port;
  // 监听 0.0.0.0 / :: 时，地址栏里应该给 127.0.0.1，否则浏览器打不开
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${displayHost}:${actualPort}`;
  const shareUrl = options.token ? `${url}/?t=${encodeURIComponent(String(options.token).trim())}` : url;

  app.server.on('close', () => {
    closed = true;
    clearTimeout(idleTimer);
    clearTimeout(firstPageTimer);
    resolveServerClosed();
  });

  return {
    ...app,
    host,
    port: actualPort,
    url,
    shareUrl,
    token: options.token ?? '',
    /** 页面全部关闭 / 手动关闭时 resolve（detach 模式靠它退出进程） */
    exited,
    /** 再挂一个监听，拿到当前和后续的页面数量 */
    onClientsChange: (listener) => {
      options.onClientsChange = listener;
      listener(app.clientCount());
    },
    close: () => {
      shutdown();
      app.closeClients();
      return serverClosed;
    },
  };
}

export { rootOf, eachNode };
