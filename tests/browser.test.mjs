/**
 * 浏览器端到端测试：用无头 Chromium 驱动真实页面，验证"人能看到/能点到"的部分。
 *
 * 没有 Chrome/Edge/Chromium 时自动跳过（不失败）——本项目的其他测试都不依赖浏览器。
 * 手动运行: node --test test/browser.test.mjs
 *
 * 这些断言刻意只检查"可量化"的事实（DOM 数量、几何、对比度、真实输入事件的结果），
 * 不做像素比对，避免不同平台字体渲染差异导致 flaky。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server/http.mjs';
import { detectEngines } from '../src/export/raster.mjs';
import { CONFIG_FILE } from '../src/server/store.mjs';

const CHROMIUM = detectEngines().chromium[0] ?? null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 极简 CDP 客户端：够用即可，不引入 puppeteer。 */
async function openBrowser(url) {
  const port = 9500 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mindleaf-browser-'));
  const child = spawn(
    CHROMIUM,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--hide-scrollbars',
      '--mute-audio',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let ws = null;
  const pending = new Map();
  const consoleErrors = [];
  let seq = 0;

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = (seq += 1);
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 25000);
    });

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };

  try {
    let ready = false;
    for (let i = 0; i < 80 && !ready; i += 1) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
      } catch {
        await sleep(250);
      }
    }
    if (!ready) throw new Error('DevTools 未就绪');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((target) => target.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      }
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    await sleep(2500);
    return {
      evaluate,
      consoleErrors,
      setViewport: (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }),
      screenshot: async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
      close: async () => {
        try {
          ws?.close();
        } catch {
          /* 忽略 */
        }
        child.kill('SIGKILL');
        fs.rmSync(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
    fs.rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

async function bootProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindleaf-e2e-'));
  fs.writeFileSync(path.join(projectDir, CONFIG_FILE), JSON.stringify({ version: 1, mapsDir: 'maps' }), 'utf8');
  const session = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
  const { doc, slug } = session.store.create({ title: '端到端测试', template: 'thesis-outline' });
  session.store.applyOps(slug, [
    {
      op: 'addNode',
      parent: 'root',
      text: '带链接的节点',
      links: [{ kind: 'code', target: 'src/core/doc.mjs#L1-L8', label: 'doc.mjs' }],
    },
  ], { by: 'user' });
  void doc;
  return { session, projectDir, slug };
}

const skip = !CHROMIUM ? '没有可用的 Chrome/Edge/Chromium' : false;

test('浏览器：页面渲染、选中、行内编辑、快捷键、撤销', { skip, timeout: 120000 }, async (t) => {
  const { session, slug } = await bootProject();
  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });

  const basics = await browser.evaluate(`({
    title: document.title,
    svg: document.querySelectorAll('#canvas-stage svg').length,
    nodes: document.querySelectorAll('#canvas-stage g[data-node-id]').length,
    sidebar: document.querySelector('#sidebar').getBoundingClientRect().width,
    canvas: document.querySelector('#canvas-area').getBoundingClientRect().width,
    inspector: document.querySelector('#inspector').getBoundingClientRect().width,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth,
    emptyHidden: document.querySelector('#empty-state').hidden,
    mapItems: document.querySelectorAll('#map-list .map-item').length,
    statusHeight: document.querySelector('.statusbar').getBoundingClientRect().height,
    viewportHeight: document.querySelector('#canvas-viewport').getBoundingClientRect().height,
    bannerHidden: document.querySelector('#external-banner').hidden,
  })`);
  assert.ok(basics.svg >= 1, '应渲染 SVG');
  assert.ok(basics.nodes > 25, `应渲染全部节点，实际 ${basics.nodes}`);
  assert.ok(basics.sidebar > 200 && basics.sidebar < 360, `侧栏宽度 ${basics.sidebar}`);
  assert.ok(basics.canvas > 700, `画布宽度 ${basics.canvas}`);
  assert.ok(basics.inspector > 200 && basics.inspector < 400, `检查器宽度 ${basics.inspector}`);
  assert.ok(basics.scrollWidth <= basics.innerWidth + 1, '不应出现横向滚动');
  assert.equal(basics.emptyHidden, true, '有导图时不应显示空状态');
  assert.equal(basics.mapItems, 1, '侧栏应列出 1 张导图');
  // 布局回归：状态栏不能被 1fr 行挤成 1px，画布不能塌成 0 高（历史 bug）
  assert.ok(basics.statusHeight >= 24 && basics.statusHeight <= 34, `状态栏高度 ${basics.statusHeight}`);
  assert.ok(basics.viewportHeight > 500, `画布高度 ${basics.viewportHeight}`);
  assert.equal(basics.bannerHidden, true, '没有外部修改时不应显示提示条');

  // 点击选中
  const box = await browser.evaluate(`(() => {
    const groups = [...document.querySelectorAll('#canvas-stage g[data-node-id]')];
    const target = groups.find((group) => [...group.querySelectorAll('text')].some((text) => text.textContent.includes('第 1 章'))) ?? groups[1];
    const rect = target.querySelector('rect').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await browser.evaluate(`(() => {
    const target = [...document.querySelectorAll('#canvas-stage g[data-node-id]')].find((g) => [...g.querySelectorAll('text')].some((t) => t.textContent.includes('带链接的节点')));
    const rect = target.querySelector('rect').getBoundingClientRect();
    const opts = { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0, pointerId: 1 };
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
  })()`);
  await sleep(400);
  const inspector = await browser.evaluate(`({
    selected: document.querySelectorAll('#canvas-stage g.is-selected').length,
    text: document.querySelector('#insp-text')?.value ?? null,
    links: document.querySelectorAll('#inspector-body .link-chip').length,
    id: document.querySelector('#insp-id')?.textContent?.trim() ?? null,
  })`);
  assert.equal(inspector.selected, 1, '选中后应只有一个高亮节点');
  assert.equal(inspector.text, '带链接的节点');
  assert.equal(inspector.links, 1, '检查器应显示 1 个链接 chip');
  void box;

  // 行内编辑 + Enter 提交
  await browser.evaluate(`(() => {
    const target = document.querySelector('#canvas-stage g.is-selected');
    const rect = target.querySelector('rect').getBoundingClientRect();
    const opts = { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, detail: 2 };
    target.dispatchEvent(new MouseEvent('dblclick', opts));
  })()`);
  await sleep(400);
  const editorOpen = await browser.evaluate(`(() => {
    const area = document.querySelector('#editor-layer textarea');
    if (!area) return false;
    area.focus();
    area.value = '端到端改的文字';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  assert.equal(editorOpen, true, '双击应打开行内编辑');
  await sleep(900);
  const afterEdit = await browser.evaluate(`(() => {
    const texts = [...document.querySelectorAll('#canvas-stage g[data-node-id] text')].map((text) => text.textContent).join('|');
    return { found: texts.includes('端到端改的文字'), editor: !!document.querySelector('#editor-layer textarea') };
  })()`);
  assert.equal(afterEdit.found, true, '提交后画布应显示新文字');
  assert.equal(afterEdit.editor, false, '提交后编辑框应关闭');

  // 服务端确实写入了
  const saved = await (await fetch(`${session.url}/api/maps/${encodeURIComponent(slug)}`)).json();
  assert.ok(saved.doc.nodes.some((node) => node.text.includes('端到端改的文字')), '修改应已落盘');
  assert.ok(saved.doc.journal.some((entry) => entry.by === 'user'), 'journal 应记录这次人类编辑');

  // 撤销 / 重做（工具栏按钮）
  const undo = await browser.evaluate(`(async () => {
    const count = () => document.querySelectorAll('#canvas-stage g[data-node-id]').length;
    const before = count();
    // 用 data-act 精确定位：右侧现在还有"含子节点"这个颜色作用域按钮，按文字匹配会点错
    const addChild = document.querySelector('#inspector-body [data-act="add-child"]');
    addChild?.click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const added = count();
    document.querySelector('#btn-undo').click();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const undone = count();
    document.querySelector('#btn-redo').click();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    return { before, added, undone, redone: count() };
  })()`);
  assert.equal(undo.added, undo.before + 1, '加子节点应 +1');
  assert.equal(undo.undone, undo.before, '撤销应回到前一状态');
  assert.equal(undo.redone, undo.added, '重做应恢复');

  // 主题与布局
  const toggles = await browser.evaluate(`(async () => {
    const themeBefore = document.documentElement.dataset.theme;
    document.querySelector('#btn-theme').click();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const themeAfter = document.documentElement.dataset.theme;
    [...document.querySelectorAll('#layout-seg [data-layout]')].find((button) => button.dataset.layout === 'both')?.click();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const sideCount = [...document.querySelectorAll('#canvas-stage g[data-node-id]')].length;
    return { themeBefore, themeAfter, sideCount, theme: document.documentElement.dataset.theme };
  })()`);
  assert.notEqual(toggles.themeBefore, toggles.themeAfter, '主题切换应生效');
  assert.ok(toggles.sideCount > 25, 'both 布局下节点仍在');

  // 外部修改（模拟 agent 写入）应被感知
  const beforeExternal = await browser.evaluate(`document.querySelectorAll('#canvas-stage g[data-node-id]').length`);
  await fetch(`${session.url}/api/maps/${encodeURIComponent(slug)}/ops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'agent', ops: [{ op: 'addNode', parent: 'root', text: 'agent 写入的节点' }] }),
  });
  await sleep(1800);
  const afterExternal = await browser.evaluate(`({
    nodes: document.querySelectorAll('#canvas-stage g[data-node-id]').length,
    banner: !document.querySelector('#external-banner').hidden,
    rev: document.querySelector('#status-rev')?.textContent ?? '',
  })`);
  assert.ok(afterExternal.nodes > beforeExternal || afterExternal.banner, 'agent 的修改应被页面感知');
  assert.match(afterExternal.rev, /\d+/, '状态栏应显示 rev');

  assert.deepEqual(browser.consoleErrors, [], `不应有控制台错误: ${browser.consoleErrors.join(' | ')}`);
});

test('浏览器：切换布局后连线仍贴合节点、内容仍在视野内', { skip, timeout: 90000 }, async (t) => {
  const { session, slug } = await bootProject();
  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });

  for (const layout of ['left', 'both', 'right']) {
    await browser.evaluate(`document.querySelector('#layout-seg [data-layout="${layout}"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const report = await browser.evaluate(`(() => {
      const svg = document.querySelector('#canvas-stage svg');
      const viewport = document.querySelector('#canvas-viewport').getBoundingClientRect();
      const boxes = [...svg.querySelectorAll('g[data-node-id]')].map((group) => {
        const rect = group.querySelector('rect');
        return { x: rect.x.baseVal.value, y: rect.y.baseVal.value, w: rect.width.baseVal.value, h: rect.height.baseVal.value };
      });
      // 注意：这里的 \d 必须写成 \\d —— 整段是模板字符串，单反斜杠会被 JS 吃掉
      const paths = [...svg.querySelectorAll('path')].filter(
        (path) => !path.closest('defs') && !path.getAttribute('marker-end'),
      );
      const onEdge = (x, y) => boxes.some((box) =>
        Math.abs(y - (box.y + box.h / 2)) < 1.5 &&
        (Math.abs(x - box.x) < 1.5 || Math.abs(x - (box.x + box.w)) < 1.5));
      const bad = [];
      for (const path of paths) {
        const nums = path.getAttribute('d').match(/-?\\d+(\\.\\d+)?/g)?.map(Number) ?? [];
        const [x0, y0, , , , , x3, y3] = nums;
        if (!onEdge(x0, y0) || !onEdge(x3, y3)) bad.push(path.getAttribute('d'));
      }
      const screen = [...svg.querySelectorAll('g[data-node-id]')].map((group) => group.getBoundingClientRect());
      const offscreen = screen.filter((box) => box.right < 0 || box.left > innerWidth || box.bottom < viewport.top || box.top > viewport.bottom).length;
      const minX = Math.min(...screen.map((box) => box.left));
      const maxX = Math.max(...screen.map((box) => box.right));
      const minY = Math.min(...screen.map((box) => box.top));
      const maxY = Math.max(...screen.map((box) => box.bottom));
      return {
        bad: bad.length,
        badSample: bad.slice(0, 2),
        edges: paths.length,
        nodes: boxes.length,
        offscreen,
        centerX: Math.round((minX + maxX) / 2 - (viewport.left + viewport.width / 2)),
        centerY: Math.round((minY + maxY) / 2 - (viewport.top + viewport.height / 2)),
        zoom: document.querySelector('#zoom-value').textContent,
      };
    })()`);
    assert.equal(report.bad, 0, `${layout}: ${report.bad} 条连线端点脱离节点 ${JSON.stringify(report.badSample)}`);
    assert.ok(report.edges >= 20, `${layout}: 树连线数量异常 ${report.edges}`);
    assert.equal(report.offscreen, 0, `${layout}: ${report.offscreen} 个节点跑出视野`);
    assert.ok(Math.abs(report.centerX) < 60, `${layout}: 水平未居中 ${report.centerX}`);
    assert.ok(Math.abs(report.centerY) < 60, `${layout}: 垂直未居中 ${report.centerY}`);
  }
});

test('浏览器：标签筛选与大纲侧栏', { skip, timeout: 90000 }, async (t) => {
  const { session, slug } = await bootProject();
  session.store.applyOps(slug, [{ op: 'setDoc', tags: ['项目', '待补'] }], { by: 'user' });
  const second = session.store.create({ title: '另一张图', tags: ['学习'] });
  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });

  // 标签筛选条 + 列表项上的标签
  const tags = await browser.evaluate(`({
    chips: [...document.querySelectorAll('#tag-filter .tag-chip')].map((chip) => chip.textContent.trim().replace(/[0-9]+$/, '')),
    itemTags: [...document.querySelectorAll('.map-item-tag')].map((chip) => chip.textContent.trim()),
    items: document.querySelectorAll('#map-list .map-item').length,
  })`);
  assert.ok(tags.chips.includes('全部'), '应有「全部」chip');
  assert.ok(tags.chips.includes('项目'), `标签条应包含「项目」: ${tags.chips}`);
  assert.ok(tags.itemTags.includes('项目'), '列表项应显示标签');
  assert.equal(tags.items, 2);

  // 点标签 → 列表只剩一张；再点一次取消
  const filtered = await browser.evaluate(`(async () => {
    document.querySelector('#tag-filter .tag-chip[data-tag="项目"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = document.querySelectorAll('#map-list .map-item').length;
    document.querySelector('#tag-filter .tag-chip.is-active')?.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { after, restored: document.querySelectorAll('#map-list .map-item').length };
  })()`);
  assert.equal(filtered.after, 1, '按标签筛选后只剩一张图');
  assert.equal(filtered.restored, 2, '取消筛选后恢复');

  // 切到大纲：行数、层级、点行选中
  const outline = await browser.evaluate(`(async () => {
    document.querySelector('#tab-outline')?.click();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const rows = [...document.querySelectorAll('#outline-panel .outline-row')];
    const fourth = rows[3];
    const targetId = fourth?.dataset.id ?? null;
    fourth?.click();
    await new Promise((resolve) => setTimeout(resolve, 700));
    return {
      visible: !document.querySelector('#outline-panel').hidden,
      count: rows.length,
      depths: [...new Set(rows.map((row) => row.style.getPropertyValue('--depth')))].join(','),
      targetId,
      selectedOnCanvas: document.querySelector('#canvas-stage g.is-selected')?.dataset.nodeId ?? null,
      selectedInOutline: document.querySelector('#outline-panel .outline-row.is-selected')?.dataset.id ?? null,
      mapListHidden: document.querySelector('#map-list').hidden,
      searchVisible: !document.querySelector('#outline-search-wrap').hidden,
    };
  })()`);
  assert.equal(outline.visible, true);
  assert.ok(outline.count > 10, `大纲行数 ${outline.count}`);
  assert.match(outline.depths, /0/, '大纲有根节点');
  assert.match(outline.depths, /1/, '大纲有一级节点');
  assert.equal(outline.mapListHidden, true, '大纲页签下应隐藏图列表');
  assert.equal(outline.searchVisible, true, '大纲页签下应有搜索框');
  assert.equal(outline.selectedOnCanvas, outline.targetId, '点大纲行应选中画布上的节点');
  assert.equal(outline.selectedInOutline, outline.targetId, '点大纲行应高亮该行');

  // 大纲搜索过滤
  const search = await browser.evaluate(`(async () => {
    const input = document.querySelector('#outline-search');
    input.value = '第 1 章';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      rows: document.querySelectorAll('#outline-panel .outline-row').length,
      matches: document.querySelectorAll('#outline-panel .outline-row.is-match').length,
    };
  })()`);
  assert.ok(search.matches >= 1, '搜索应有命中');
  assert.ok(search.rows <= outline.count, '搜索后行数应减少');

  // 标签编辑对话框
  const dialog = await browser.evaluate(`(async () => {
    document.querySelector('#tab-maps').click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    document.querySelector('.map-item[data-slug="${slug}"] .map-item-tags-edit')?.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const open = document.querySelector('#dlg-tags')?.open ?? false;
    const value = document.querySelector('#tags-input')?.value ?? '';
    const input = document.querySelector('#tags-input');
    input.value = '项目, 复盘';
    document.querySelector('#form-tags')?.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return {
      open,
      value,
      closedAfterSave: !(document.querySelector('#dlg-tags')?.open ?? false),
      itemTags: [...document.querySelectorAll('.map-item-tag')].map((chip) => chip.textContent.trim()),
    };
  })()`);
  assert.equal(dialog.open, true, '应打开标签对话框');
  assert.match(dialog.value, /项目/, '对话框应预填现有标签');
  assert.equal(dialog.closedAfterSave, true, '保存后应关闭');
  assert.ok(dialog.itemTags.includes('复盘'), `保存后列表应显示新标签: ${dialog.itemTags}`);

  const persisted = session.store.read(slug).doc;
  assert.deepEqual(persisted.tags, ['项目', '复盘'], '标签应写入文件');
  void second;
  assert.deepEqual(browser.consoleErrors, [], `不应有控制台错误: ${browser.consoleErrors.join(' | ')}`);
});

test('浏览器：节点三种颜色，单节点与含子节点', { skip, timeout: 90000 }, async (t) => {
  const { session, slug } = await bootProject();
  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });

  // 选中一个一级分支（有子节点）
  const branch = await browser.evaluate(`(async () => {
    const groups = [...document.querySelectorAll('#canvas-stage g[data-node-id]')];
    const target = groups.find((group) => {
      const text = [...group.querySelectorAll('text')].map((item) => item.textContent).join('');
      return text.includes('第 1 章');
    }) ?? groups[1];
    const rect = target.querySelector('rect').getBoundingClientRect();
    const opts = { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0, pointerId: 1 };
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { id: target.dataset.nodeId };
  })()`);
  assert.ok(branch.id, '应选中一个节点');

  const rows = await browser.evaluate(`({
    labels: [...document.querySelectorAll('.color-row .color-label')].map((item) => item.textContent.trim()),
    scopes: [...document.querySelectorAll('#style-scope .seg-btn')].map((item) => item.textContent.trim()),
    custom: document.querySelectorAll('.swatch.custom input[type=color]').length,
  })`);
  assert.deepEqual(rows.labels, ['模块', '文字', '连线'], `颜色行: ${rows.labels}`);
  assert.deepEqual(rows.scopes, ['本节点', '含子节点']);
  assert.equal(rows.custom, 3, '三行都应有自定义取色');

  // 单节点：改文字色和连线色
  await browser.evaluate(`(async () => {
    document.querySelector('.swatch[data-field="textColor"][data-value="#b91c1c"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 800));
    document.querySelector('.swatch[data-field="lineColor"][data-value="#0ea5e9"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 900));
  })()`);
  let doc = session.store.read(slug).doc;
  let node = doc.nodes.find((item) => item.id === branch.id);
  assert.equal(node.textColor, '#b91c1c', '字体色应写入文件');
  assert.equal(node.lineColor, '#0ea5e9', '连线色应写入文件');

  const painted = await browser.evaluate(`({
    textFill: [...document.querySelectorAll('#canvas-stage g[data-node-id] text')].some((item) => item.getAttribute('fill') === '#b91c1c'),
    lineStroke: [...document.querySelectorAll('#canvas-stage path')].some((item) => item.getAttribute('stroke') === '#0ea5e9'),
  })`);
  assert.equal(painted.textFill, true, '画布上应出现自定义字色');
  assert.equal(painted.lineStroke, true, '画布上应出现自定义连线色');

  // 切到「含子节点」→ 改模块底色 → 子节点一起变
  const subtree = await browser.evaluate(`(async () => {
    document.querySelector('#style-scope [data-scope="subtree"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const hint = !!document.querySelector('.color-hint');
    document.querySelector('.swatch[data-field="color"][data-value="#fecdd3"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { hint };
  })()`);
  assert.equal(subtree.hint, true, '子树模式应有提示');
  doc = session.store.read(slug).doc;
  node = doc.nodes.find((item) => item.id === branch.id);
  const kids = doc.nodes.filter((item) => item.parent === branch.id);
  assert.equal(node.color, '#fecdd3');
  assert.ok(kids.length > 0, '该分支应有子节点');
  assert.ok(kids.every((item) => item.color === '#fecdd3'), '子节点应一起被染色');

  assert.deepEqual(browser.consoleErrors, [], `不应有控制台错误: ${browser.consoleErrors.join(' | ')}`);
});

test('浏览器：字号、字体、框尺寸，单节点与整枝字号', { skip, timeout: 90000 }, async (t) => {
  const { session, slug } = await bootProject();
  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });

  const branch = await browser.evaluate(`(async () => {
    const groups = [...document.querySelectorAll('#canvas-stage g[data-node-id]')];
    const target = groups.find((group) => [...group.querySelectorAll('text')].some((item) => item.textContent.includes('第 1 章'))) ?? groups[1];
    const rect = target.querySelector('rect').getBoundingClientRect();
    const opts = { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0, pointerId: 1 };
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    await new Promise((resolve) => setTimeout(resolve, 500));
    return target.dataset.nodeId;
  })()`);

  const controls = await browser.evaluate(`({
    fontSize: !!document.querySelector('[data-act="font-size"]'),
    font: !!document.querySelector('[data-act="font-family"]'),
    sizes: [...document.querySelectorAll('[data-act="box-size"]')].map((item) => item.dataset.field),
    options: [...document.querySelectorAll('[data-act="font-family"] option')].map((item) => item.textContent),
  })`);
  assert.equal(controls.fontSize, true, '应有字号下拉');
  assert.equal(controls.font, true, '应有字体下拉');
  assert.deepEqual(controls.sizes, ['boxWidth', 'boxHeight']);
  assert.ok(controls.options.includes('楷体'), `字体选项: ${controls.options}`);

  // 字号 22 + 楷体 + 框宽 220
  await browser.evaluate(`(async () => {
    const size = document.querySelector('[data-act="font-size"]');
    size.value = '22';
    size.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    const font = document.querySelector('[data-act="font-family"]');
    font.value = 'kai';
    font.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    const width = document.querySelector('[data-act="box-size"][data-field="boxWidth"]');
    width.value = '220';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 800));
  })()`);
  let doc = session.store.read(slug).doc;
  let node = doc.nodes.find((item) => item.id === branch);
  assert.equal(node.fontSize, 22);
  assert.equal(node.font, 'kai');
  assert.equal(node.boxWidth, 220);

  const painted = await browser.evaluate(`(() => {
    const group = document.querySelector('#canvas-stage g[data-node-id][data-node-id="${branch}"]');
    const text = group?.querySelector('text');
    const rect = group?.querySelector('rect');
    return {
      family: text?.getAttribute('font-family') ?? '',
      size: text?.getAttribute('font-size'),
      width: Math.round(rect?.width.baseVal.value ?? 0),
    };
  })()`);
  assert.match(painted.family, /Kaiti|KaiTi/, '画布应使用楷体');
  assert.equal(painted.size, '22', '画布应使用 22px');
  assert.equal(painted.width, 220, '框宽应变成 220');

  // 整枝改字号
  await browser.evaluate(`(async () => {
    document.querySelector('#style-scope [data-scope="subtree"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const size = document.querySelector('[data-act="font-size"]');
    size.value = '16';
    size.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 900));
  })()`);
  doc = session.store.read(slug).doc;
  node = doc.nodes.find((item) => item.id === branch);
  const kids = doc.nodes.filter((item) => item.parent === branch);
  assert.equal(node.fontSize, 16);
  assert.ok(kids.length > 0);
  assert.ok(kids.every((item) => item.fontSize === 16), '子节点字号应一起改');
  assert.deepEqual(browser.consoleErrors, [], `不应有控制台错误: ${browser.consoleErrors.join(' | ')}`);
});

test('浏览器：带图标的按钮，图标和文字都垂直居中', { skip, timeout: 90000 }, async (t) => {
  const { session, slug } = await bootProject();
  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });

  const boxes = await browser.evaluate(`(() => {
    const measure = (selector) => {
      const button = document.querySelector(selector);
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      const icon = button.querySelector('svg');
      const iconRect = icon?.getBoundingClientRect();
      // 文字可能是裸文本节点（如「新建导图」），也可能包在 span 里（如「导出」）
      const textNode = [...button.childNodes].find((node) => node.nodeType === 3 && node.textContent.trim());
      const textHost = textNode ?? [...button.children].find((node) => node.tagName === 'SPAN' && node.textContent.trim());
      const range = document.createRange();
      range.selectNodeContents(textNode ?? textHost);
      const textRect = range.getBoundingClientRect();
      return {
        selector,
        buttonCenter: rect.top + rect.height / 2,
        iconHeight: iconRect ? Math.round(iconRect.height * 10) / 10 : null,
        iconCenter: iconRect ? iconRect.top + iconRect.height / 2 : null,
        textCenter: textRect.top + textRect.height / 2,
        display: getComputedStyle(button).display,
        direction: getComputedStyle(button).flexDirection,
      };
    };
    return [measure('#btn-new-map'), measure('#btn-export')].filter(Boolean);
  })()`);
  assert.equal(boxes.length, 2, '应能量到两个带图标的按钮');
  for (const box of boxes) {
    // 作为 flex 子项时 inline-flex 会被 blockify 成 flex，两种都算正常
    assert.ok(['flex', 'inline-flex'].includes(box.display), `${box.selector} 应该是 flex 容器，实际 ${box.display}`);
    assert.equal(box.direction, 'row', `${box.selector} 不该变成纵向排列，实际 ${box.direction}`);
    assert.ok(box.iconHeight >= 14.5, `${box.selector} 的图标不该被压扁：${box.iconHeight}px`);
    assert.ok(Math.abs(box.iconCenter - box.buttonCenter) <= 1, `${box.selector} 图标应垂直居中（偏差 ${(box.iconCenter - box.buttonCenter).toFixed(1)}px）`);
    assert.ok(Math.abs(box.textCenter - box.buttonCenter) <= 1, `${box.selector} 文字应垂直居中（偏差 ${(box.textCenter - box.buttonCenter).toFixed(1)}px）`);
  }

  assert.deepEqual(browser.consoleErrors, [], `不应有控制台错误: ${browser.consoleErrors.join(' | ')}`);
});

test('浏览器：手动拖过的备注/批注框高度不会因为切换节点被重置', { skip, timeout: 120000 }, async (t) => {
  const { session, slug } = await bootProject();
  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });

  const result = await browser.evaluate(`(async () => {
    const groups = [...document.querySelectorAll('#canvas-stage g[data-node-id]')];
    const click = async (group, offsetX) => {
      const rect = group.querySelector('rect').getBoundingClientRect();
      const opts = { bubbles: true, clientX: rect.x + (offsetX ?? 10), clientY: rect.y + rect.height / 2, button: 0, pointerId: 1 };
      group.dispatchEvent(new PointerEvent('pointerdown', opts));
      group.dispatchEvent(new PointerEvent('pointerup', opts));
      group.dispatchEvent(new MouseEvent('click', opts));
      await new Promise((resolve) => setTimeout(resolve, 500));
    };

    await click(groups[1]);
    const defaultHeight = document.querySelector('#insp-note').getBoundingClientRect().height;

    // 模拟用户拖大两个输入框
    document.querySelector('#insp-note').style.height = '190px';
    document.querySelector('#insp-annotation').style.height = '150px';
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 切到别的节点，再切回来
    await click(groups[3]);
    const otherNode = {
      note: document.querySelector('#insp-note').getBoundingClientRect().height,
      annotation: document.querySelector('#insp-annotation').getBoundingClientRect().height,
    };
    await click(groups[1]);
    const back = {
      note: document.querySelector('#insp-note').getBoundingClientRect().height,
      annotation: document.querySelector('#insp-annotation').getBoundingClientRect().height,
    };
    return { defaultHeight, otherNode, back, stored: localStorage.getItem('mindleaf:field-heights') };
  })()`);
  assert.ok(result.defaultHeight < 150, `默认高度应该较小，实际 ${result.defaultHeight}`);
  assert.equal(Math.round(result.otherNode.note), 190, '换节点后备注框仍是我拖过的高度');
  assert.equal(Math.round(result.otherNode.annotation), 150, '换节点后批注框仍是我拖过的高度');
  assert.equal(Math.round(result.back.note), 190, '切回来也不变');
  assert.match(result.stored ?? '', /insp-note/, '高度应被记住');

  assert.deepEqual(browser.consoleErrors, [], `不应有控制台错误: ${browser.consoleErrors.join(' | ')}`);
});

test('浏览器：关联线可以点选、改说明/颜色/备注/批注', { skip, timeout: 120000 }, async (t) => {
  const { session, slug } = await bootProject();
  const doc = session.store.read(slug).doc;
  const [a, b] = doc.nodes.filter((node) => node.parent === 'root' && node.id !== 'root');
  session.store.applyOps(slug, [{ op: 'addEdge', from: a.id, to: b.id, label: '核对' }], { by: 'user' });
  const edgeId = session.store.read(slug).doc.edges[0].id;

  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });

  // 点线的中点
  const clicked = await browser.evaluate(`(async () => {
    const group = document.querySelector('#canvas-stage g.mm-edge[data-edge-id="${edgeId}"]');
    const path = group.querySelector('.mm-edge-line');
    const point = path.getPointAtLength(path.getTotalLength() * 0.5);
    const ctm = path.getScreenCTM();
    const x = point.x * ctm.a + point.y * ctm.c + ctm.e;
    const y = point.x * ctm.b + point.y * ctm.d + ctm.f;
    const opts = { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 };
    path.dispatchEvent(new PointerEvent('pointerdown', opts));
    path.dispatchEvent(new PointerEvent('pointerup', opts));
    await new Promise((resolve) => setTimeout(resolve, 600));
    return {
      selected: document.querySelectorAll('#canvas-stage g.mm-edge.is-selected').length,
      label: document.querySelector('#edge-label')?.value,
      hasNote: !!document.querySelector('#edge-note'),
      hasAnnotation: !!document.querySelector('#edge-annotation'),
      swatches: document.querySelectorAll('[data-act="edge-style"]').length,
      ends: [...document.querySelectorAll('.edge-end')].map((item) => item.textContent),
    };
  })()`);
  assert.equal(clicked.selected, 1, '点击后该关联线应高亮选中');
  assert.equal(clicked.label, '核对', '面板里应显示当前说明');
  assert.equal(clicked.hasNote, true, '面板应有备注');
  assert.equal(clicked.hasAnnotation, true, '面板应有批注');
  assert.ok(clicked.swatches >= 7, '面板应有预设色 + 清除');
  assert.equal(clicked.ends.length, 2, '面板应显示两端节点');

  // 改说明 / 颜色 / 备注 / 批注
  await browser.evaluate(`(async () => {
    const label = document.querySelector('#edge-label');
    label.value = '核对解析策略';
    label.dispatchEvent(new Event('input', { bubbles: true }));
    label.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    document.querySelector('[data-act="edge-style"][data-value="#ef4444"]').click();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const note = document.querySelector('#edge-note');
    note.value = '这条线给自己看';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    note.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    const ann = document.querySelector('#edge-annotation');
    ann.value = '这条依赖已经不成立';
    ann.dispatchEvent(new Event('input', { bubbles: true }));
    ann.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  })()`);
  let edge = session.store.read(slug).doc.edges.find((item) => item.id === edgeId);
  assert.equal(edge.label, '核对解析策略');
  assert.equal(edge.color, '#ef4444');
  assert.equal(edge.note, '这条线给自己看');
  assert.equal(edge.annotation, '这条依赖已经不成立');

  // 有批注的线换成蓝色箭头
  const blue = await browser.evaluate(`!!document.querySelector('#canvas-stage g.mm-edge[data-edge-id="${edgeId}"] [marker-end*="arrow-annotation"]')`);
  assert.equal(blue, true, '有关联线批注时箭头应为蓝色');

  // 删除（走确认框）
  await browser.evaluate(`document.querySelector('[data-act="edge-remove"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const dialogOpen = await browser.evaluate(`!!document.querySelector('#dlg-confirm').open`);
  assert.equal(dialogOpen, true, '删除关联线应先确认');
  await browser.evaluate(`document.querySelector('#confirm-ok').click()`);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(session.store.read(slug).doc.edges.some((item) => item.id === edgeId), false, '确认后应删除');

  assert.deepEqual(browser.consoleErrors, [], `不应有控制台错误: ${browser.consoleErrors.join(' | ')}`);
});

test('浏览器：选中节点后点「加关联线」再点另一个节点即可新建', { skip, timeout: 120000 }, async (t) => {
  const { session, slug } = await bootProject();
  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });

  const created = await browser.evaluate(`(async () => {
    const groups = [...document.querySelectorAll('#canvas-stage g[data-node-id]')];
    const clickNode = async (group) => {
      const rect = group.querySelector('rect').getBoundingClientRect();
      const opts = { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0, pointerId: 1 };
      group.dispatchEvent(new PointerEvent('pointerdown', opts));
      group.dispatchEvent(new PointerEvent('pointerup', opts));
      group.dispatchEvent(new MouseEvent('click', opts));
      await new Promise((resolve) => setTimeout(resolve, 450));
    };
    const first = groups[1];
    const second = groups[groups.length - 1];
    await clickNode(first);
    const button = document.querySelector('[data-act="start-link"]');
    const hasButton = !!button;

    button.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const hintShown = !document.querySelector('#link-hint').hidden;
    const sourceMarked = document.querySelectorAll('#canvas-stage g.is-link-source').length;
    await clickNode(second);
    await new Promise((resolve) => setTimeout(resolve, 900));
    return {
      hasButton,
      hintShown,
      sourceMarked,
      hintGone: document.querySelector('#link-hint').hidden,
      panelOpen: !!document.querySelector('#edge-label'),
      ends: [...document.querySelectorAll('.edge-end')].map((item) => item.textContent),
      firstId: first.dataset.nodeId,
      secondId: second.dataset.nodeId,
    };
  })()`);
  assert.equal(created.hasButton, true, '节点面板右下应有「加关联线」');
  assert.equal(created.hintShown, true, '进入连线模式应有提示条');
  assert.equal(created.sourceMarked, 1, '起点节点应被标出来');
  assert.equal(created.hintGone, true, '连完线提示条应消失');
  assert.equal(created.panelOpen, true, '连好后应直接打开新关联线的面板');

  const edges = session.store.read(slug).doc.edges;
  assert.equal(edges.length, 1, '应新增一条关联线');
  assert.equal(edges[0].from, created.firstId);
  assert.equal(edges[0].to, created.secondId);

  // 反向
  await browser.evaluate(`document.querySelector('[data-act="edge-reverse"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const reversed = session.store.read(slug).doc.edges[0];
  assert.equal(reversed.from, created.secondId);
  assert.equal(reversed.to, created.firstId);

  // Esc 取消连线模式
  const cancelled = await browser.evaluate(`(async () => {
    const group = [...document.querySelectorAll('#canvas-stage g[data-node-id]')].pop();
    const rect = group.querySelector('rect').getBoundingClientRect();
    // 靠左一点点，避开可能压在节点上的关联线标签
    const opts = { bubbles: true, clientX: rect.x + 10, clientY: rect.y + rect.height / 2, button: 0, pointerId: 1 };
    group.dispatchEvent(new PointerEvent('pointerdown', opts));
    group.dispatchEvent(new PointerEvent('pointerup', opts));
    group.dispatchEvent(new MouseEvent('click', opts));
    await new Promise((resolve) => setTimeout(resolve, 450));
    document.querySelector('[data-act="start-link"]').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { hintGone: document.querySelector('#link-hint').hidden };
  })()`);
  assert.equal(cancelled.hintGone, true, 'Esc 应取消连线模式');
  assert.equal(session.store.read(slug).doc.edges.length, 1, '取消后不应新增关联线');

  assert.deepEqual(browser.consoleErrors, [], `不应有控制台错误: ${browser.consoleErrors.join(' | ')}`);
});

test('浏览器：新建节点沿用上一个节点的颜色', { skip, timeout: 120000 }, async (t) => {
  const { session, slug } = await bootProject();
  // 先给一个一级节点上色
  const doc = session.store.read(slug).doc;
  const colored = doc.nodes.find((node) => node.depth !== 0 && node.parent === 'root');
  session.store.applyOps(slug, [{ op: 'updateNode', id: colored.id, color: '#fecdd3' }], { by: 'user' });

  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });

  // 选中该节点 → Enter 加同级节点
  const created = await browser.evaluate(`(async () => {
    const group = document.querySelector('#canvas-stage g[data-node-id][data-node-id="${colored.id}"]');
    const rect = group.querySelector('rect').getBoundingClientRect();
    const opts = { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0, pointerId: 1 };
    group.dispatchEvent(new PointerEvent('pointerdown', opts));
    group.dispatchEvent(new PointerEvent('pointerup', opts));
    group.dispatchEvent(new MouseEvent('click', opts));
    await new Promise((resolve) => setTimeout(resolve, 400));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    const selected = document.querySelector('#canvas-stage g[data-node-id].is-selected');
    const fill = selected?.querySelector('rect')?.getAttribute('fill');
    return { id: selected?.dataset.nodeId, fill };
  })()`);
  assert.ok(created.id && created.id !== colored.id, '应新建一个节点并选中');
  const saved = session.store.read(slug).doc.nodes.find((node) => node.id === created.id);
  assert.equal(saved.color, '#fecdd3', '新节点应沿用上一个节点的颜色');
  assert.equal(created.fill, '#fecdd3', '画布上新节点也应该是这个颜色');

  assert.deepEqual(browser.consoleErrors, [], `不应有控制台错误: ${browser.consoleErrors.join(' | ')}`);
});

test('浏览器：节点批注 —— 写在备注和颜色之间，落盘并显示标记', { skip, timeout: 120000 }, async (t) => {
  const { session, slug } = await bootProject();
  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });

  // 选中一个节点
  const nodeId = await browser.evaluate(`(async () => {
    const groups = [...document.querySelectorAll('#canvas-stage g[data-node-id]')];
    const target = groups[1] ?? groups[0];
    const rect = target.querySelector('rect').getBoundingClientRect();
    const opts = { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0, pointerId: 1 };
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    await new Promise((resolve) => setTimeout(resolve, 500));
    return target.dataset.nodeId;
  })()`);

  // 位置检查：批注在备注之后、颜色之前
  const order = await browser.evaluate(`(() => {
    const section = document.querySelector('#insp-annotation')?.closest('section');
    const note = document.querySelector('#insp-note')?.closest('section');
    const color = document.querySelector('.color-head')?.closest('section');
    const sections = [...document.querySelectorAll('.insp-scroll > section')];
    return {
      annotation: sections.indexOf(section),
      note: sections.indexOf(note),
      color: sections.indexOf(color),
      placeholder: document.querySelector('#insp-annotation')?.placeholder ?? '',
    };
  })()`);
  assert.ok(order.note >= 0 && order.annotation > order.note, `批注应在备注之后：备注 ${order.note}，批注 ${order.annotation}`);
  assert.ok(order.color > order.annotation, `批注应在颜色之前：批注 ${order.annotation}，颜色 ${order.color}`);
  assert.match(order.placeholder, /AI/);

  // 写一段批注，等防抖落盘
  await browser.evaluate(`(async () => {
    const box = document.querySelector('#insp-annotation');
    box.focus();
    box.value = '把这三个子节点合并成两个，名字再短一点';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    box.blur();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 切到别的节点再切回来，强制检查器重绘（和用户切走再切回来一样）
    const clickNode = async (group) => {
      const rect = group.querySelector('rect').getBoundingClientRect();
      const opts = { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0, pointerId: 1 };
      group.dispatchEvent(new PointerEvent('pointerdown', opts));
      group.dispatchEvent(new PointerEvent('pointerup', opts));
      group.dispatchEvent(new MouseEvent('click', opts));
      await new Promise((resolve) => setTimeout(resolve, 400));
    };
    const groups = [...document.querySelectorAll('#canvas-stage g[data-node-id]')];
    const target = groups.find((group) => group.dataset.nodeId === '${nodeId}');
    await clickNode(groups.find((group) => group.dataset.nodeId !== '${nodeId}'));
    await clickNode(target);
  })()`);
  let doc = session.store.read(slug).doc;
  let node = doc.nodes.find((item) => item.id === nodeId);
  assert.equal(node.annotation, '把这三个子节点合并成两个，名字再短一点', '批注应写进文件');

  // 画布上出现标记
  const marked = await browser.evaluate(`({
    marks: document.querySelectorAll('#canvas-stage [data-annotation="1"]').length,
    markFill: document.querySelector('#canvas-stage [data-annotation="1"]')?.getAttribute('fill'),
    filled: document.querySelector('#insp-annotation').classList.contains('has-value'),
    value: document.querySelector('#insp-annotation').value,
    hasClear: !!document.querySelector('[data-act="annotation-clear"]'),
  })`);
  assert.equal(marked.marks, 1, '画布上该节点应有批注标记');
  assert.equal(marked.markFill, '#2563eb', '批注标记应为蓝色小点');
  assert.equal(marked.value, '把这三个子节点合并成两个，名字再短一点', '重选节点后批注应回显');
  assert.equal(marked.filled, true, '有批注时输入框应有高亮状态');
  assert.equal(marked.hasClear, true, '有批注时应出现「清空」按钮');

  // 大纲里也有标记
  await browser.evaluate(`(async () => {
    document.querySelector('#tab-outline').click();
    await new Promise((resolve) => setTimeout(resolve, 600));
  })()`);
  const inOutline = await browser.evaluate(`document.querySelectorAll('.outline-annotation-dot').length`);
  assert.equal(inOutline, 1, '大纲里也应有批注标记');
  await browser.evaluate(`document.querySelector('#tab-maps').click()`);

  // 清空按钮
  await browser.evaluate(`(async () => {
    document.querySelector('#insp-annotation')?.closest('section');
    document.querySelector('[data-act="annotation-clear"]').click();
    await new Promise((resolve) => setTimeout(resolve, 900));
  })()`);
  doc = session.store.read(slug).doc;
  node = doc.nodes.find((item) => item.id === nodeId);
  assert.equal(node.annotation, undefined, '清空后文件里不应再有批注');
  const afterClean = await browser.evaluate(`document.querySelectorAll('#canvas-stage [data-annotation="1"]').length`);
  assert.equal(afterClean, 0, '清空后画布标记应消失');

  assert.deepEqual(browser.consoleErrors, [], `不应有控制台错误: ${browser.consoleErrors.join(' | ')}`);
});

test('浏览器：节点备注悬停提示（延迟可设置、位置跟随鼠标、字号跟随侧栏）', { skip, timeout: 120000 }, async (t) => {
  const { session, slug } = await bootProject();
  const noteText = '这条备注用来验证悬停提示：停留够久就浮出来，移开就消失。';
  session.store.applyOps(slug, [{ op: 'updateNode', id: session.store.read(slug).doc.nodes[1].id, note: noteText }], { by: 'user' });
  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });

  const hover = (delayMs) =>
    browser.evaluate(`(async () => {
      // 通过设置界面改延迟（和用户操作一致）
      document.querySelector('#btn-settings').click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const select = document.querySelector('#set-note-delay');
      select.value = '${delayMs}';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#dlg-settings').close();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const groups = [...document.querySelectorAll('#canvas-stage g[data-node-id]')];
      const target = groups[1];
      const rect = target.querySelector('rect').getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse' }));
      const rightAfter = document.querySelector('#note-tooltip').hidden;
      await new Promise((resolve) => setTimeout(resolve, ${delayMs} + 700));
      const tip = document.querySelector('#note-tooltip');
      const box = tip.getBoundingClientRect();
      return {
        rightAfter,
        hidden: tip.hidden,
        body: document.querySelector('#note-tooltip-body').textContent,
        title: document.querySelector('#note-tooltip-title').textContent,
        fontSize: getComputedStyle(tip).fontSize,
        left: Math.round(box.left),
        top: Math.round(box.top),
        mouseX: Math.round(x),
        mouseY: Math.round(y),
      };
    })()`);

  const shown = await hover(1000);
  assert.equal(shown.rightAfter, true, '刚移上去时不该立刻弹');
  assert.equal(shown.hidden, false, '停留 1 秒后应弹出');
  assert.equal(shown.body, noteText, '气泡里应显示备注原文');
  assert.ok(shown.title.length > 0, '气泡应有节点标题');
  assert.ok(shown.left >= shown.mouseX - 40 && shown.top >= shown.mouseY - 40, '气泡应出现在鼠标附近');
  assert.equal(shown.fontSize, '12.8px', '默认字号与侧栏一致');

  // 移开就消失
  const moved = await browser.evaluate(`(async () => {
    const viewport = document.querySelector('#canvas-viewport');
    viewport.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 4, clientY: 4, pointerId: 1, pointerType: 'mouse' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    return document.querySelector('#note-tooltip').hidden;
  })()`);
  assert.equal(moved, true, '鼠标移开后气泡应消失');

  // 关掉（延迟 0）就不弹
  const off = await hover(0);
  assert.equal(off.hidden, true, '设置成关闭后不应弹出');

  // 字号跟随侧栏字号
  const scaled = await browser.evaluate(`(async () => {
    document.querySelector('#btn-settings').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const scale = document.querySelector('#set-ui-scale');
    scale.value = '1.25';
    scale.dispatchEvent(new Event('change', { bubbles: true }));
    const delay = document.querySelector('#set-note-delay');
    delay.value = '500';
    delay.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#dlg-settings').close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const groups = [...document.querySelectorAll('#canvas-stage g[data-node-id]')];
    const rect = groups[1].querySelector('rect').getBoundingClientRect();
    groups[1].dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.x + 8, clientY: rect.y + 8, pointerId: 1, pointerType: 'mouse' }));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const tip = document.querySelector('#note-tooltip');
    return { hidden: tip.hidden, fontSize: getComputedStyle(tip).fontSize };
  })()`);
  assert.equal(scaled.hidden, false);
  assert.equal(scaled.fontSize, '16px', '侧栏字号 1.25 时气泡字号也应是 12.8×1.25');

  assert.deepEqual(browser.consoleErrors, [], `不应有控制台错误: ${browser.consoleErrors.join(' | ')}`);
});

test('浏览器：左右栏拖动改宽、设置里改侧栏字号', { skip, timeout: 120000 }, async (t) => {
  const { session, slug } = await bootProject();
  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });

  const measure = () =>
    browser.evaluate(`({
      sidebar: Math.round(document.querySelector('#sidebar').getBoundingClientRect().width),
      inspector: Math.round(document.querySelector('#inspector').getBoundingClientRect().width),
      canvas: Math.round(document.querySelector('#canvas-area').getBoundingClientRect().width),
      leftHandle: !document.querySelector('#resizer-left').hidden,
      rightHandle: !document.querySelector('#resizer-right').hidden,
    })`);

  const start = await measure();
  assert.equal(start.sidebar, 272, `侧栏默认 272px，实际 ${start.sidebar}`);
  assert.equal(start.inspector, 332, `属性栏默认 332px，实际 ${start.inspector}`);
  assert.equal(start.leftHandle, true, '左侧应有拖动把手');
  assert.equal(start.rightHandle, true, '右侧应有拖动把手');

  // 拖左边把手向右 80px
  const dragBy = (selector, dx) =>
    browser.evaluate(`(async () => {
      const handle = document.querySelector('${selector}');
      const rect = handle.getBoundingClientRect();
      const point = (x) => ({ bubbles: true, cancelable: true, clientX: x, clientY: 300, button: 0, pointerId: 1, pointerType: 'mouse' });
      handle.dispatchEvent(new PointerEvent('pointerdown', point(rect.x + 3)));
      await new Promise((resolve) => setTimeout(resolve, 30));
      for (let step = 1; step <= 8; step += 1) {
        window.dispatchEvent(new PointerEvent('pointermove', point(rect.x + 3 + (${dx} * step) / 8)));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      window.dispatchEvent(new PointerEvent('pointerup', point(rect.x + 3 + ${dx})));
      await new Promise((resolve) => setTimeout(resolve, 250));
    })()`);

  await dragBy('#resizer-left', 80);
  const afterLeft = await measure();
  assert.ok(Math.abs(afterLeft.sidebar - (start.sidebar + 80)) <= 2, `侧栏应约 352px，实际 ${afterLeft.sidebar}`);
  assert.equal(afterLeft.inspector, start.inspector, '拖左边不应影响右边');
  assert.ok(afterLeft.canvas < start.canvas, '画布应变窄');

  await dragBy('#resizer-right', -70);
  const afterRight = await measure();
  assert.ok(Math.abs(afterRight.inspector - (start.inspector + 70)) <= 2, `属性栏应约 402px，实际 ${afterRight.inspector}`);
  assert.ok(afterRight.canvas < afterLeft.canvas, '画布应再窄一点');

  // 刷新后宽度还在
  await browser.evaluate(`location.reload()`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const reloaded = await measure();
  assert.equal(reloaded.sidebar, afterRight.sidebar, '刷新后侧栏宽度应被记住');
  assert.equal(reloaded.inspector, afterRight.inspector, '刷新后属性栏宽度应被记住');

  // 设置里改侧栏字号
  const zoomed = await browser.evaluate(`(async () => {
    document.querySelector('#btn-settings').click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const select = document.querySelector('#set-ui-scale');
    select.value = '1.25';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const app = document.querySelector('#app');
    return {
      zoomVar: getComputedStyle(app).getPropertyValue('--panel-zoom').trim(),
      sidebarZoom: getComputedStyle(document.querySelector('#sidebar')).zoom,
      inspectorZoom: getComputedStyle(document.querySelector('#inspector')).zoom,
      canvasZoom: getComputedStyle(document.querySelector('#canvas-area')).zoom,
      widthText: document.querySelector('#set-panel-widths').textContent,
    };
  })()`);
  assert.equal(zoomed.zoomVar, '1.25');
  assert.equal(Number(zoomed.sidebarZoom), 1.25, '侧栏应放大');
  assert.equal(Number(zoomed.inspectorZoom), 1.25, '属性栏应放大');
  assert.equal(Number(zoomed.canvasZoom), 1, '画布不应被缩放');
  assert.match(zoomed.widthText, /左 \d+px · 右 \d+px/);

  // 恢复默认栏宽
  await browser.evaluate(`document.querySelector('#btn-reset-panels').click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const reset = await measure();
  assert.equal(reset.sidebar, 272, '恢复默认后侧栏 272px');
  assert.equal(reset.inspector, 332, '恢复默认后属性栏 332px');

  assert.deepEqual(browser.consoleErrors, [], `不应有控制台错误: ${browser.consoleErrors.join(' | ')}`);
});

test('浏览器：窄屏不崩、无横向滚动', { skip, timeout: 60000 }, async (t) => {
  const { session, slug } = await bootProject();
  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });
  for (const [width, height] of [
    [900, 700],
    [390, 844],
  ]) {
    await browser.setViewport(width, height);
    await sleep(800);
    const narrow = await browser.evaluate(`({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      canvas: document.querySelector('#canvas-area').getBoundingClientRect().width,
      canvasHeight: document.querySelector('#canvas-viewport').getBoundingClientRect().height,
      statusHeight: document.querySelector('.statusbar').getBoundingClientRect().height,
      svgWidth: document.querySelector('#canvas-stage svg')?.getBoundingClientRect().width ?? 0,
      nodes: document.querySelectorAll('#canvas-stage g[data-node-id]').length,
    })`);
    assert.ok(narrow.scrollWidth <= narrow.innerWidth + 1, `${width}px 下出现横向滚动: ${narrow.scrollWidth}`);
    assert.ok(narrow.canvas > width * 0.55, `${width}px 下画布过窄: ${narrow.canvas}`);
    assert.ok(narrow.nodes > 10, `${width}px 下节点应仍渲染`);
    assert.ok(narrow.canvasHeight > height * 0.6, `${width}px 下画布高度塌陷: ${narrow.canvasHeight}`);
    assert.ok(narrow.statusHeight >= 24, `${width}px 下状态栏被压扁: ${narrow.statusHeight}`);
    assert.ok(narrow.svgWidth > 40, `${width}px 下 SVG 不可见: ${narrow.svgWidth}`);
  }
});

test('浏览器：新建对话框能从接口加载模板', { skip, timeout: 60000 }, async (t) => {
  const { session, slug } = await bootProject();
  const browser = await openBrowser(`${session.url}/#${encodeURIComponent(slug)}`);
  t.after(async () => {
    await browser.close();
    await session.close();
  });
  const dialog = await browser.evaluate(`(async () => {
    document.querySelector('#btn-new-map').click();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const cards = [...document.querySelectorAll('#tpl-grid .tpl-card')];
    return {
      open: document.querySelector('#dlg-map')?.open ?? false,
      cards: cards.length,
      titles: cards.map((card) => card.querySelector('.tpl-title')?.textContent?.trim() ?? ''),
      active: cards.filter((card) => card.classList.contains('is-active')).length,
    };
  })()`);
  assert.equal(dialog.open, true, '新建对话框应打开');
  assert.ok(dialog.cards >= 10, `模板卡片应 ≥ 10，实际 ${dialog.cards}`);
  assert.ok(dialog.titles.includes('论文提纲'), '应包含论文提纲模板');
  assert.equal(dialog.active, 1, '应默认选中一张卡片');
});
