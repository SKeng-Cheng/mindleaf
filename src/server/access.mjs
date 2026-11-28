/**
 * 访问入口：算"本人打开"和"发给对方"两个网址，以及访问口令。
 *
 * CLI（mm serve）、MCP（open_in_browser）、双击启动脚本都走这里，
 * 保证三个入口给出的地址和口令完全一致。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 虚拟网卡前缀：虚拟机桥接、容器、VPN 冒出来的地址不该当成"协作入口"。 */
const VIRTUAL_IFACE = /^(bridge|vmnet|vboxnet|docker|utun|awdl|llw|anpi|gif|stf|p2p|tun|tap|zt)/i;

/** 本机所有可对外的 IPv4。 */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      out.push({ name, address: item.address });
    }
  }
  return out;
}

/** 最可能是"给别人用"的那个地址：优先真实网卡，其次常见私网段。 */
export function primaryLanAddress() {
  const all = lanAddresses();
  if (!all.length) return null;
  const ifaceRank = (name) => (/^en\d/i.test(name) ? 0 : /^eth\d/i.test(name) ? 1 : /^wl/i.test(name) ? 2 : 3);
  const ipRank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  return all.sort((a, b) => ifaceRank(a.name) - ifaceRank(b.name) || ipRank(a.address) - ipRank(b.address))[0].address;
}

/** 这个监听地址是不是"所有网卡"。 */
export const isAllInterfaces = (host) => host === '0.0.0.0' || host === '::' || host === '';

const tokenFile = (projectDir) => path.join(projectDir, '.mindleaf', 'token');

/** 读之前保存的口令（没有就返回空串）。 */
function readSavedToken(projectDir) {
  try {
    const value = fs.readFileSync(tokenFile(projectDir), 'utf8').trim();
    return /^[A-Za-z0-9_-]{4,64}$/.test(value) ? value : '';
  } catch {
    return '';
  }
}

function saveToken(projectDir, token) {
  try {
    const file = tokenFile(projectDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  } catch {
    /* 写不了就算了，本次运行照样用这个口令 */
  }
}

/** 随机口令，8 位，够挡"同网段随手扫"的人。 */
export function randomToken() {
  return crypto.randomBytes(6).toString('base64url');
}

/**
 * 决定本次服务用的口令。
 * @param {string} projectDir
 * @param {{token?:string, noToken?:boolean}} options
 * @returns {string} 空串表示不要口令
 */
export function resolveToken(projectDir, options = {}) {
  if (options.noToken) return '';
  const explicit = typeof options.token === 'string' ? options.token.trim() : '';
  if (explicit) {
    saveToken(projectDir, explicit);
    return explicit;
  }
  // 没显式给：沿用上次的，这样发给对方的网址不会每次变
  const saved = readSavedToken(projectDir);
  if (saved) return saved;
  const fresh = randomToken();
  saveToken(projectDir, fresh);
  return fresh;
}

/** 看看服务是否在跑（用来判断"已经在运行"）。 */
export async function pingServer(url, token) {
  try {
    const response = await fetch(`${url}/api/health`, {
      headers: token ? { 'x-mindleaf-token': token } : undefined,
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 算两个入口。
 * @param {{port:number, listenHost?:string, token?:string, map?:string}} options
 * @returns {{local:string, lan:string|null, same:boolean}}
 */
export function accessEntries(options = {}) {
  const port = options.port;
  const token = options.token ? `/?t=${encodeURIComponent(options.token)}` : '/';
  const hash = options.map ? `#${encodeURIComponent(options.map)}` : '';
  const local = `http://127.0.0.1:${port}${token}${hash}`;
  const all = isAllInterfaces(options.listenHost ?? '0.0.0.0');
  const lanIp = all ? primaryLanAddress() : null;
  const lan = lanIp ? `http://${lanIp}:${port}${token}${hash}` : null;
  return { local, lan, same: !lan || lan === local };
}

/**
 * 打印给人看的两行入口（本地 + 协作）。两人入口相同就只打一行。
 * @param {(text:string)=>string} dim
 * @param {(text:string)=>string} bold
 */
export function formatAccessEntries(entries, { dim = (t) => t, bold = (t) => t } = {}) {
  if (entries.same) {
    return [`  ${bold('打开')}      ${entries.local}`];
  }
  return [`  ${bold('本人打开')}  ${entries.local}`, `  ${bold('发给对方')}  ${entries.lan}${dim('   ← 同一个局域网就能开')}`];
}
