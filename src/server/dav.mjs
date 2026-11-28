/**
 * 最小可用的 WebDAV 服务：把"分享文件清单"里的文件暴露成一个可挂载的网盘目录。
 *
 * 用途：docx / pptx / pdf 这类文件浏览器里没法就地编辑，但对方可以把它挂载到
 * Finder / 资源管理器，用自己电脑上的 Office 直接打开、改完保存 —— 文件始终在你机器上，
 * 对方那边不会有副本。
 *
 * 边界（刻意做窄）：
 * - 只暴露分享清单里出现过的文件，**不是整个工作区**
 * - 只有 mode=rw 的条目能 PUT；其余只读
 * - 不支持新建目录、删除、重命名（MKCOL / DELETE / MOVE 一律 405）
 * - 鉴权：Basic（用户名随意，密码是访问口令）或 ?t=口令 / cookie
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};

const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
const xmlEsc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const httpDate = (ms = Date.now()) => new Date(ms).toUTCString();
const etagOf = (stat) => `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;

/** 把 URL 路径规整成相对 workspaceDir 的 posix 路径（'' 表示根）。 */
export function davRelativePath(urlPath) {
  let rest = String(urlPath ?? '/').replace(/^\/dav\/?/, '');
  try {
    rest = decodeURIComponent(rest);
  } catch {
    /* 保持原样 */
  }
  rest = rest.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  if (!rest) return '';
  if (rest.split('/').includes('..')) return null;
  return rest;
}

/**
 * 收集允许访问的分享文件：规整成 { rel, abs, rw, ownerSlug }。
 * 同一个文件被多张图分享时，只要有一处是 rw 就可写。
 */
export function collectShared(store) {
  const map = new Map();
  for (const entry of store.list()) {
    let doc;
    try {
      doc = store.read(entry.slug).doc;
    } catch {
      continue;
    }
    for (const file of doc.sharedFiles ?? []) {
      const abs = store.resolveSharedPath(file.path);
      if (!abs) continue;
      const current = map.get(file.path);
      if (!current) {
        map.set(file.path, { rel: file.path, abs, rw: file.mode === 'rw', ownerSlug: entry.slug });
      } else if (file.mode === 'rw') {
        current.rw = true;
      }
    }
  }
  return [...map.values()];
}

/** 目录前缀下有哪些条目（也包含中间层目录，方便挂载后能一层层点进去）。 */
function listUnder(entries, prefix) {
  const dirs = new Set();
  const files = [];
  for (const entry of entries) {
    if (prefix && entry.rel !== prefix && !entry.rel.startsWith(`${prefix}/`)) continue;
    const rest = prefix ? entry.rel.slice(prefix.length + 1) : entry.rel;
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash >= 0) dirs.add(rest.slice(0, slash));
    else files.push(entry);
  }
  return { dirs: [...dirs].sort(), files };
}

function propstat({ href, isDir, stat, rw }) {
  const props = [
    `<D:displayname>${xmlEsc(decodeURIComponent(href.split('/').filter(Boolean).pop() ?? ''))}</D:displayname>`,
    isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>',
    `<D:getlastmodified>${httpDate(stat?.mtimeMs)}</D:getlastmodified>`,
    isDir ? '' : `<D:getcontentlength>${stat?.size ?? 0}</D:getcontentlength>`,
    isDir ? '' : `<D:getcontenttype>${mimeOf(href)}</D:getcontenttype>`,
    isDir ? '' : `<D:getetag>${etagOf(stat)}</D:getetag>`,
    `<D:supportedlock>${rw ? '<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' : ''}</D:supportedlock>`,
    `<D:lockdiscovery/>`,
  ];
  return `<D:response><D:href>${xmlEsc(href)}</D:href><D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multistatus(res, body, status = 207) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`;
  res.writeHead(status, {
    'content-type': 'application/xml; charset=utf-8',
    'content-length': Buffer.byteLength(xml),
    'cache-control': 'no-store',
  });
  res.end(xml);
}

const text = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
};

function readRaw(req, max = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(Object.assign(new Error('文件太大'), { code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 处理 /dav/* 请求。返回 true 表示已经处理。
 * @param {{req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse, store:any, locks:Map<string,{token:string}>}} ctx
 */
export async function handleDav({ req, res, store, locks, rawPath }) {
  // 注意：必须用原始请求行里的路径。再走一次 URL 解析会把 %2e%2e 规范化成 ..，
  // 那样"../.."就被提前消化掉，反而绕过了下面的检查。
  const rel = davRelativePath(rawPath ?? req.url ?? '/');
  if (rel === null) return text(res, 403, '非法路径'), true;

  const entries = collectShared(store);
  const byRel = new Map(entries.map((entry) => [entry.rel, entry]));
  const file = byRel.get(rel);
  const { dirs, files } = listUnder(entries, rel);
  const isDir = !file && (rel === '' || dirs.length > 0 || files.length > 0);
  const davHref = (value) => `/dav/${value.split('/').map(encodeURIComponent).join('/')}${value && !file ? '/' : ''}`;

  switch (req.method) {
    case 'OPTIONS':
      res.writeHead(200, {
        DAV: '1, 2',
        Allow: 'OPTIONS, GET, HEAD, PUT, PROPFIND, LOCK, UNLOCK',
        'MS-Author-Via': 'DAV',
        'content-length': 0,
      });
      res.end();
      return true;

    case 'PROPFIND': {
      const depth = String(req.headers.depth ?? '1');
      if (!isDir && !file) return text(res, 404, '不是一个分享文件'), true;
      const parts = [];
      if (rel !== '' || isDir) {
        const stat = rel === '' ? { mtimeMs: Date.now(), size: 0 } : null;
        parts.push(propstat({ href: davHref(rel), isDir: true, stat: stat ?? undefined, rw: false }));
      }
      if (depth !== '0') {
        for (const dir of dirs) {
          const child = rel ? `${rel}/${dir}` : dir;
          parts.push(propstat({ href: davHref(child), isDir: true, stat: undefined, rw: false }));
        }
        for (const item of files) {
          let stat = null;
          try {
            stat = fs.statSync(item.abs);
          } catch {
            continue;
          }
          parts.push(propstat({ href: `/dav/${item.rel.split('/').map(encodeURIComponent).join('/')}`, isDir: false, stat, rw: item.rw }));
        }
      }
      if (file) {
        const stat = fs.statSync(file.abs);
        multistatus(res, propstat({ href: `/dav/${file.rel.split('/').map(encodeURIComponent).join('/')}`, isDir: false, stat, rw: file.rw }));
        return true;
      }
      multistatus(res, parts.join(''));
      return true;
    }

    case 'GET':
    case 'HEAD': {
      if (!file) return text(res, 404, '不是一个分享文件'), true;
      let stat;
      try {
        stat = fs.statSync(file.abs);
      } catch {
        return text(res, 404, '文件不存在'), true;
      }
      res.writeHead(200, {
        'content-type': mimeOf(file.abs),
        'content-length': stat.size,
        'last-modified': httpDate(stat.mtimeMs),
        etag: etagOf(stat),
        'accept-ranges': 'bytes',
      });
      if (req.method === 'HEAD') return res.end(), true;
      fs.createReadStream(file.abs).pipe(res);
      return true;
    }

    case 'PUT': {
      if (!file) return text(res, 403, '只能修改分享清单里的文件'), true;
      if (!file.rw) return text(res, 403, '这个文件是只读分享'), true;
      const buffer = await readRaw(req);
      const tmp = `${file.abs}.mindleaf-put`;
      try {
        fs.writeFileSync(tmp, buffer);
        fs.renameSync(tmp, file.abs);
      } catch (error) {
        fs.rmSync(tmp, { force: true });
        return text(res, 500, `写入失败: ${error?.message ?? error}`), true;
      }
      const stat = fs.statSync(file.abs);
      res.writeHead(204, { etag: etagOf(stat), 'last-modified': httpDate(stat.mtimeMs) });
      res.end();
      return true;
    }

    case 'LOCK': {
      // Office 保存前会先 LOCK；这里给一个"名义锁"，不影响写入（清单本身就是白名单）
      if (!file && !isDir) return text(res, 403, '只能锁定分享清单里的文件'), true;
      if (file && !file.rw) return text(res, 403, '这个文件是只读分享'), true;
      const token = `opaquelocktoken:${crypto.randomUUID()}`;
      locks.set(rel, { token, at: Date.now() });
      const body =
        `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
        `<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth>` +
        `<D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken>` +
        `</D:activelock></D:lockdiscovery></D:prop>`;
      res.writeHead(200, {
        'content-type': 'application/xml; charset=utf-8',
        'lock-token': `<${token}>`,
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return true;
    }

    case 'UNLOCK':
      locks.delete(rel);
      res.writeHead(204);
      res.end();
      return true;

    case 'MKCOL':
    case 'DELETE':
    case 'MOVE':
    case 'COPY':
      return text(res, 405, '这个网盘是只读目录，只允许修改分享清单里的文件'), true;

    default:
      return text(res, 405, '不支持的方法'), true;
  }
}
