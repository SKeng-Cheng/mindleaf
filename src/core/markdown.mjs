/**
 * Markdown <-> 导图。
 *
 * 约定：标题层级 = 父子层级。
 *   # 根节点
 *   ## 一级分支
 *   ### 二级分支
 * 节点下的无序列表/段落当作 note（备注），列表里以 `- [链接文字](目标)` 书写链接。
 * 这种映射保证导图能被任何 Markdown 编辑器打开，也能被人类直接手写。
 */
import { createDoc, normalizeDoc, rootOf, childrenMap, getNode, eachNode, guessLinkKind } from './doc.mjs';

const LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s<>()（）「」]+/g;

/**
 * 从一行文字里抽出链接：支持 `[文字](目标)`（目标可含空格）和裸 URL。
 * 返回 {text, links}，text 里的链接被替换成 `[[文字]]` 方便调用方再处理。
 */
function parseLinks(line) {
  const links = [];
  let text = String(line ?? '');
  text = text.replace(LINK_RE, (_, label, rawTarget) => {
    const target = String(rawTarget ?? '')
      .replace(/\s+"[^"]*"\s*$/, '')
      .trim();
    if (!target) return label;
    links.push({ kind: guessLinkKind(target), label: label.trim() || undefined, target });
    return `[[${label.trim()}]]`;
  });
  text = text.replace(BARE_URL_RE, (url) => {
    links.push({ kind: 'url', target: url.replace(/[.,;:]+$/, '') });
    return url.replace(/[.,;:]+$/, '');
  });
  return { text, links };
}

function leafText(line) {
  const { text, links } = parseLinks(line);
  const value = text.replace(/\[\[([^\]]*)\]\]/g, '$1').trim();
  return { value, links };
}

/**
 * Markdown -> 文档。
 * @param {string} markdown
 * @param {{title?:string, splitLevel?:number}} options
 *   splitLevel：第几级标题作为根节点，默认 1（`#`）。若文档没有 `#`，自动用第一个标题层级作根。
 */
export function fromMarkdown(markdown, options = {}) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const title = options.title;
  const map = new Map(); // 节点对象 -> note 行
  const nodes = [];
  let rootText = null;

  // 先找出真正的最小标题级别，容忍 `#` 被跳过的情况
  let minLevel = Infinity;
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) minLevel = Math.min(minLevel, m[1].length);
  }
  const baseLevel = Number.isInteger(options.splitLevel) && options.splitLevel > 0 ? options.splitLevel : (Number.isFinite(minLevel) ? minLevel : 1);

  const stack = []; // [{level, nodeId}]
  let mode = null; // 'heading' | 'note'
  let current = null;
  let codeFence = false;
  let inFrontMatter = false;

  const addNode = (text, level) => {
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].node : null;
    const { value, links } = leafText(text);
    const node = {
      id: `n_${nodes.length}_${Math.random().toString(36).slice(2, 6)}`,
      parent: parent ? parent.id : null,
      text: value || '(空)',
      note: '',
      order: nodes.filter((n) => n.parent === (parent ? parent.id : null)).length,
      collapsed: false,
      links,
    };
    nodes.push(node);
    stack.push({ level, node });
    return node;
  };

  // 根节点：如果是 `# 标题`，直接作为根；再上面若还有内容，放到根 note 里
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (i === 0 && /^---\s*$/.test(line)) {
      inFrontMatter = true;
      continue;
    }
    if (inFrontMatter) {
      if (/^---\s*$/.test(line)) inFrontMatter = false;
      continue;
    }
    if (/^```/.test(line)) {
      codeFence = !codeFence;
      if (current) {
        current.note += (current.note ? '\n' : '') + line;
      } else if (nodes.length) {
        nodes[nodes.length - 1].note += (nodes[nodes.length - 1].note ? '\n' : '') + line;
      }
      continue;
    }
    if (codeFence) {
      if (current) current.note += (current.note ? '\n' : '') + line;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      if (!nodes.length && level === baseLevel) {
        const { value, links } = leafText(text);
        rootText = value || '(空)';
        const root = {
          id: 'root',
          parent: null,
          text: rootText,
          note: '',
          order: 0,
          collapsed: false,
          links,
        };
        nodes.push(root);
        stack.push({ level: baseLevel, node: root });
        current = root;
        mode = 'heading';
        continue;
      }
      current = addNode(text, level);
      mode = 'heading';
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      mode = mode ?? null;
      continue;
    }
    // 节点正文：列表项 / 段落，作为 note
    if (mode === 'heading' && current) {
      mode = 'note';
    }
    const target = nodes.length ? nodes[nodes.length - 1] : null;
    if (!target) continue;
    current = target;
    const bullet = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    const body = bullet ? bullet[1] : trimmed;
    const { text: linkText, links } = parseLinks(body);
    for (const link of links) {
      if (!target.links.some((item) => item.target === link.target)) target.links.push(link);
    }
    const noteLine = linkText.replace(/\[\[([^\]]*)\]\]/g, '$1').trim();
    if (noteLine) target.note += (target.note ? '\n' : '') + noteLine;
  }

  if (!nodes.length) {
    nodes.push({
      id: 'root',
      parent: null,
      text: title || '未命名导图',
      note: '',
      order: 0,
      collapsed: false,
      links: [],
    });
  }
  // 若没有以 `#` 开头的根，合成一个
  let roots = nodes.filter((n) => n.parent == null);
  if (!roots.length || roots[0].text == null) {
    const synthetic = {
      id: 'root',
      parent: null,
      text: title || '未命名导图',
      note: '',
      order: 0,
      collapsed: false,
      links: [],
    };
    nodes.unshift(synthetic);
    roots = [synthetic];
    for (const node of nodes.slice(1)) if (node.parent == null && node !== synthetic) node.parent = 'root';
  } else if (roots.length > 1) {
    const root = roots[0];
    root.id = 'root';
    root.parent = null;
    for (const other of roots.slice(1)) other.parent = 'root';
  } else if (roots[0].id !== 'root') {
    roots[0].id = 'root';
  }
  // 根节点若有前置内容（第一个标题之前），尽量存进 note
  return normalizeDoc({
    title: title || rootText || '未命名导图',
    nodes,
    settings: options.settings,
  });
}

const escapeMd = (text) => String(text ?? '').replace(/\r?\n/g, ' ');

function linkToMd(link) {
  const label = link.label || link.target;
  return `[${escapeMd(label)}](${link.target})`;
}

/** 文档 -> Markdown（标题层级 + 备注 + 链接）。 */
export function toMarkdown(doc, options = {}) {
  const headingBase = Number.isInteger(options.headingBase) ? options.headingBase : 1;
  const withIds = options.withIds === true;
  const lines = [];
  const children = childrenMap(doc);
  const walk = (node, depth) => {
    const level = Math.min(6, headingBase + depth);
    lines.push(`${'#'.repeat(level)} ${escapeMd(node.text)}${withIds ? ` <!--${node.id}-->` : ''}`);
    const noteLines = (node.note ?? '').split('\n').filter((line) => line.trim());
    if (noteLines.length) {
      lines.push('');
      for (const line of noteLines) lines.push(line.trim());
    }
    if ((node.links ?? []).length) {
      lines.push('');
      for (const link of node.links) lines.push(`- ${linkToMd(link)}`);
    }
    for (const child of children.get(node.id) ?? []) {
      lines.push('');
      walk(child, depth + 1);
    }
  };
  walk(rootOf(doc), 0);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** 从 Markdown 片段里找第一个标题，用作标题猜测。 */
export function guessTitle(markdown) {
  const m = /^#{1,6}\s+(.+)$/m.exec(String(markdown ?? ''));
  return m ? m[1].trim() : null;
}
