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

  const state = () => ({
    ...store.summary(),
    engines: {
      chromium: engines.chromium.length > 0,
      chromiumPath: engines.chromium[0] ?? null,
      png: engines.png,
      pdf: engines.pdf,
    },
    formats: EXPORT_FORMATS,
    version: readVersion(),
  });

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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = decodeURIComponent(url.pathname);
    res.setHeader('x-mindleaf', '1');
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
        fail(res, error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400, error.code, error.message, error.current ? { current: error.current } : {});
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
  const url = `http://${host}:${actualPort}`;

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
