/**
 * 光栅化 / PDF 后端探测。
 *
 * 导出 PNG、JPG、PDF 需要"把 SVG 变成像素"或"把网页变成 PDF"的能力。
 * Node 没有内置渲染器，所以按优先级借用系统里已有的程序，全部可选：
 *
 *   chromium 系（Chrome / Edge / Chromium / Brave）—— 保真度最高，PDF 还是矢量文字
 *   sips      —— macOS 自带，SVG -> PNG/JPEG
 *   qlmanage  —— macOS 自带，SVG -> PNG（兜底）
 *   rsvg-convert / inkscape —— Linux 常见
 *
 * 一个都没有也不影响：JSON/Markdown/SVG/HTML 导出和网页里"浏览器内导出 PNG/JPG"仍然可用。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PT_PER_PX } from './pdf.mjs';

const CHROMIUM_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

const PATH_CANDIDATES = ['rsvg-convert', 'inkscape', 'sips', 'qlmanage'];

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function which(command) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** 探测所有可用后端。 */
export function detectEngines() {
  const chromium = [];
  for (const candidate of CHROMIUM_CANDIDATES[process.platform] ?? []) {
    if (exists(candidate)) chromium.push(candidate);
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'msedge', 'brave-browser']) {
    const found = which(name);
    if (found && !chromium.includes(found)) chromium.push(found);
  }
  const tools = {};
  for (const name of PATH_CANDIDATES) {
    const found = which(name);
    if (found) tools[name] = found;
  }
  return {
    chromium,
    sips: tools.sips ?? null,
    qlmanage: tools.qlmanage ?? null,
    rsvg: tools['rsvg-convert'] ?? null,
    inkscape: tools.inkscape ?? null,
    png: chromium.length > 0 || Boolean(tools.sips) || Boolean(tools['rsvg-convert']) || Boolean(tools.inkscape) || Boolean(tools.qlmanage),
    pdf: chromium.length > 0 || Boolean(tools.sips) || Boolean(tools['rsvg-convert']) || Boolean(tools.inkscape),
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    }, options.timeoutMs ?? 60000);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function tempDir(prefix = 'mindleaf-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

function toFileUrl(file) {
  const normalized = path.resolve(file).replace(/\\/g, '/');
  const encoded = normalized
    .split('/')
    .map((segment, index) => (index === 0 ? '' : encodeURIComponent(segment)))
    .join('/');
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

/** 把 SVG 包成一个刚好同尺寸的 HTML（Chromium 截图/打印都用它）。 */
export function svgToHtmlPage(svg, { width, height, title = 'Mindleaf' } = {}) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${String(title).replace(/[<&>]/g, '')}</title>
<style>
  @page { size: ${(width * PT_PER_PX).toFixed(2)}pt ${(height * PT_PER_PX).toFixed(2)}pt; margin: 0; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { width: ${width}px; height: ${height}px; overflow: hidden; }
  svg { display: block; width: ${width}px; height: ${height}px; }
</style></head>
<body>${svg}</body></html>`;
}

async function chromiumScreenshot(chromePath, htmlFile, pngFile, width, height) {
  const profile = tempDir('mindleaf-chrome-');
  try {
    const baseArgs = [
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--mute-audio',
      `--user-data-dir=${profile}`,
      `--window-size=${Math.round(width)},${Math.round(height)}`,
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--screenshot=${pngFile}`,
      `--virtual-time-budget=1500`,
      toFileUrl(htmlFile),
    ];
    for (const headless of ['--headless=new', '--headless']) {
      try {
        fs.rmSync(pngFile, { force: true });
      } catch {
        /* 忽略 */
      }
      const result = await run(chromePath, [headless, ...baseArgs], { timeoutMs: 45000 });
      if (exists(pngFile) && fs.statSync(pngFile).size > 0) return { ok: true };
      if (!/headless|unknown|unrecognized/i.test(result.stderr)) {
        // 不是 headless 参数问题，就不再重试第二种写法
        if (result.code === 0 && exists(pngFile)) return { ok: true };
      }
    }
    return { ok: false };
  } finally {
    rmrf(profile);
  }
}

/**
 * SVG -> PNG 文件。
 * @returns {Promise<{ok:boolean, engine:string|null, error?:string}>}
 */
export async function rasterizeSvgToPng(svg, { width, height, outPath, engines = detectEngines() }) {
  const workDir = tempDir();
  const svgFile = path.join(workDir, 'map.svg');
  fs.writeFileSync(svgFile, svg, 'utf8');
  try {
    for (const chromePath of engines.chromium) {
      const htmlFile = path.join(workDir, 'map.html');
      fs.writeFileSync(htmlFile, svgToHtmlPage(svg, { width, height }), 'utf8');
      const result = await chromiumScreenshot(chromePath, htmlFile, outPath, width, height);
      if (result.ok) return { ok: true, engine: `chromium:${path.basename(chromePath)}` };
    }
    if (engines.rsvg) {
      const result = await run(engines.rsvg, ['-w', String(Math.round(width)), '-h', String(Math.round(height)), '-o', outPath, svgFile]);
      if (result.code === 0 && exists(outPath)) return { ok: true, engine: 'rsvg-convert' };
    }
    if (engines.inkscape) {
      const result = await run(engines.inkscape, ['--export-type=png', `--export-filename=${outPath}`, `--export-width=${Math.round(width)}`, svgFile], {
        timeoutMs: 60000,
      });
      if (result.code === 0 && exists(outPath)) return { ok: true, engine: 'inkscape' };
    }
    if (engines.sips) {
      const result = await run(engines.sips, ['-s', 'format', 'png', svgFile, '--out', outPath]);
      if (result.code === 0 && exists(outPath)) return { ok: true, engine: 'sips' };
    }
    if (engines.qlmanage) {
      const result = await run(engines.qlmanage, ['-t', '-s', String(Math.round(Math.max(width, height))), '-o', workDir, svgFile]);
      const produced = path.join(workDir, 'map.svg.png');
      if (result.code === 0 && exists(produced)) {
        fs.copyFileSync(produced, outPath);
        return { ok: true, engine: 'qlmanage' };
      }
    }
    return { ok: false, engine: null, error: '没有可用的 SVG 光栅化后端（Chrome/Edge/sips/rsvg-convert 都没有找到）' };
  } finally {
    rmrf(workDir);
  }
}

/**
 * SVG -> PDF（矢量文字）文件；只有 Chromium 能做到。
 * @returns {Promise<{ok:boolean, engine:string|null, error?:string}>}
 */
export async function svgToPdfViaChromium(svg, { width, height, outPath, title, engines = detectEngines() }) {
  if (!engines.chromium.length) return { ok: false, engine: null, error: '没有找到 Chrome/Edge，无法生成矢量 PDF' };
  const workDir = tempDir();
  try {
    const htmlFile = path.join(workDir, 'map.html');
    fs.writeFileSync(htmlFile, svgToHtmlPage(svg, { width, height, title }), 'utf8');
    for (const chromePath of engines.chromium) {
      const profile = tempDir('mindleaf-chrome-');
      try {
        for (const headless of ['--headless=new', '--headless']) {
          try {
            fs.rmSync(outPath, { force: true });
          } catch {
            /* 忽略 */
          }
          const args = [
            headless,
            '--disable-gpu',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',
            `--user-data-dir=${profile}`,
            '--no-pdf-header-footer',
            `--print-to-pdf=${outPath}`,
            '--virtual-time-budget=1500',
            toFileUrl(htmlFile),
          ];
          await run(chromePath, args, { timeoutMs: 45000 });
          if (exists(outPath) && fs.statSync(outPath).size > 800) {
            return { ok: true, engine: `chromium-pdf:${path.basename(chromePath)}` };
          }
        }
      } finally {
        rmrf(profile);
      }
    }
    return { ok: false, engine: null, error: 'Chromium 打印 PDF 失败' };
  } finally {
    rmrf(workDir);
  }
}

/** 打开系统默认浏览器（尽力而为）。 */
export function openInBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return run(command, args, { timeoutMs: 8000 });
}
