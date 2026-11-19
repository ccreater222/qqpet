/**
 * docs 检查器的纯函数库。
 *
 * 设计约束：
 * - 零第三方依赖，只使用 Node.js 内置模块；
 * - 所有路径统一为仓库相对的 POSIX 路径；
 * - 检查器自身遇到无法判断的输入时显式失败，不静默放行。
 */
import fs from 'node:fs';
import path from 'node:path';

export const LIVING_DIRS = ['standards', 'specs', 'architecture', 'guides', 'runbooks'];
export const FROZEN_PREFIX = 'docs/reviews/';
export const INDEX_DOC = 'docs/README.md';
export const RUNBOOK_INDEX = 'docs/runbooks/README.md';
export const DOC_MAP_PATH = 'docs/doc-map.json';

const FORBIDDEN_NAME_TOKENS = new Set(['v2', 'v3', 'v4', 'final', 'old', 'copy', 'tmp', 'draft']);
const FORBIDDEN_NAME_FRAGMENTS = ['副本', '备份', '最终版', '草稿'];

const INDEX_LINE_LIMIT = 500;
const GUIDE_LINE_LIMIT = 1000;
const RUNBOOK_LINE_LIMIT = 900;
const DIR_LINE_LIMIT = 600;

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.py',
  '.sh',
  '.bash',
  '.sql',
  '.yml',
  '.yaml',
  '.json',
  '.md',
  '.txt',
  '.example',
  '.conf',
  '.toml',
  '.ini',
  // native / 前端宿主语言：注释里引用文档同样必须命中
  '.kt',
  '.kts',
  '.java',
  '.m',
  '.mm',
  '.h',
  '.swift',
  '.ets',
  '.xml',
  '.plist',
  '.html',
  '.css',
  '.gradle',
]);

const SKIP_SOURCE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'tmp',
  '.worktrees',
  '.agent-reports',
  'vendor',
  '__pycache__',
]);

/**
 * 测试夹具故意引用不存在的 docs 路径，真实仓库全量检查必须跳过，
 * 否则夹具本身会变成误报来源。
 */
const SKIP_SOURCE_PREFIXES = ['scripts/docs/tests/fixtures/'];

/** 统一为仓库相对的 POSIX 路径。 */
export function normalizeRepoPath(input) {
  const normalized = String(input).replace(/\\/g, '/').replace(/^\.\//, '');
  return path.posix.normalize(normalized);
}

function isMissingError(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/**
 * 逐级校验路径大小写。macOS 默认文件系统不区分大小写，
 * 直接用 existsSync 会放过在 Linux 上断掉的链接。
 */
export function existsWithExactCase(root, repoRelativePath) {
  const normalized = normalizeRepoPath(repoRelativePath);
  if (normalized === '.' || normalized === '') return true;
  let current = root;
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch (error) {
      if (isMissingError(error)) return false;
      throw error;
    }
    if (!entries.includes(part)) return false;
    current = path.join(current, part);
  }
  return true;
}

function stripLeadingSlash(input) {
  return input.replace(/^\/+/, '');
}

function globToRegExp(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]+/)*';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  source += '$';
  return new RegExp(source);
}

/** glob 语义：`*` 不跨目录，`**` 可跨目录。 */
export function matchesGlob(filePath, pattern) {
  const normalizedFile = stripLeadingSlash(normalizeRepoPath(filePath));
  const normalizedPattern = stripLeadingSlash(normalizeRepoPath(pattern));
  return globToRegExp(normalizedPattern).test(normalizedFile);
}

export function matchesAnyGlob(filePath, patterns) {
  return patterns.some((pattern) => matchesGlob(filePath, pattern));
}

export function matchesRule(filePath, rule) {
  if (!matchesAnyGlob(filePath, rule.include ?? [])) return false;
  return !matchesAnyGlob(filePath, rule.exclude ?? []);
}

/**
 * 计算 staged 代码变更是否同时更新了映射文档。
 *
 * entries 为 `[{status, path}]`，直接来自
 * `git diff --cached --name-status --no-renames -z`。
 * - 删除文档（D）不算“更新文档”；
 * - 删除代码（D）仍然是一次契约变更，必须更新文档。
 */
export function computeStagedImpact(entries, rules) {
  const normalized = entries.map((entry) => ({
    status: String(entry.status ?? ''),
    path: normalizeRepoPath(entry.path),
  }));
  const stagedDocPaths = new Set(
    normalized.filter((entry) => !entry.status.startsWith('D')).map((entry) => entry.path),
  );
  const changedPaths = [...new Set(normalized.map((entry) => entry.path))];

  const failures = [];
  const warnings = [];
  const impacts = [];

  for (const rule of rules) {
    const codeFiles = changedPaths.filter((file) => matchesRule(file, rule));
    if (codeFiles.length === 0) continue;

    const docs = rule.docs.map(normalizeRepoPath);
    const stagedDocs = docs.filter((docPath) => stagedDocPaths.has(docPath));
    const missingDocs = docs.filter((docPath) => !stagedDocPaths.has(docPath));
    const impact = { rule, codeFiles, stagedDocs, missingDocs };
    impacts.push(impact);

    if (stagedDocs.length > 0) continue;
    if (rule.mode === 'warn') warnings.push(impact);
    else failures.push(impact);
  }

  return { ok: failures.length === 0, failures, warnings, impacts };
}

/**
 * 冻结证据前缀：任何提交改动这些路径都是违规，与 doc-map 是否命中无关。
 * 它们是只读历史，不是“需要同步的 living 文档”。
 */
const FROZEN_EVIDENCE_PREFIXES = ['docs/reviews/', 'docs/superpowers/'];

/**
 * 提交信息里的显式跳过理由，格式必须与 commit-msg 钩子逐字一致：
 * `Docs-Check: off — <至少 8 个字符的理由>`（行首、固定前缀、em dash）。
 */
export function hasValidDocsCheckWaiver(message) {
  for (const line of String(message ?? '').split(/\r?\n/)) {
    const match = line.match(/^Docs-Check: off — (.*)$/);
    if (match && match[1].length >= 8) return true;
  }
  return false;
}

/** 列出一次提交中触碰冻结证据的路径。 */
export function findFrozenEvidencePaths(entries) {
  const paths = [];
  for (const entry of entries ?? []) {
    const normalized = normalizeRepoPath(entry.path);
    if (FROZEN_EVIDENCE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      paths.push(normalized);
    }
  }
  return [...new Set(paths)].sort();
}

/**
 * 逐提交评估文档同步（供 `--range` 使用）。
 *
 * commits 为 `[{commit, subject, message, entries}]`，entries 来自
 * `git diff-tree --no-commit-id --name-status --no-renames -r -z`。
 * 与 staged 检查共用同一套 doc-map 语义：
 * - 删除文档不算“更新文档”，删除代码仍算契约变更；
 * - `warn` 只提醒，不失败；
 * - 仅当该提交信息带合法 `Docs-Check: off — <理由>` 时，才允许缺文档；
 * - 触碰 `docs/reviews/**` 或 `docs/superpowers/**` 的提交一律失败，
 *   不受 doc-map 与跳过 trailer 影响（冻结证据只读）。
 */
export function evaluateRangeCommits(commits, rules) {
  const checked = [];
  const failures = [];
  const warnings = [];

  for (const item of commits) {
    checked.push({ commit: item.commit, subject: item.subject });

    const frozenPaths = findFrozenEvidencePaths(item.entries);
    if (frozenPaths.length > 0) {
      failures.push({
        commit: item.commit,
        subject: item.subject,
        code: 'frozen-evidence-modified',
        paths: frozenPaths,
      });
    }

    const waived = hasValidDocsCheckWaiver(item.message);
    const impact = computeStagedImpact(item.entries ?? [], rules);

    for (const failure of impact.failures) {
      if (waived) continue;
      failures.push({
        commit: item.commit,
        subject: item.subject,
        rule: failure.rule,
        codeFiles: failure.codeFiles,
        missingDocs: failure.missingDocs,
      });
    }
    for (const warning of impact.warnings) {
      warnings.push({
        commit: item.commit,
        subject: item.subject,
        rule: warning.rule,
        codeFiles: warning.codeFiles,
        missingDocs: warning.missingDocs,
      });
    }
  }

  return { ok: failures.length === 0, commits: checked, failures, warnings };
}

/* ------------------------------------------------------------------ *
 * Markdown 解析
 * ------------------------------------------------------------------ */

function maskFencedBlocks(content) {
  const lines = content.split('\n');
  let inFence = false;
  let fenceChar = null;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trimStart();
    const match = trimmed.match(/^(```+|~~~+)/);
    if (match) {
      const char = match[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = char;
      } else if (char === fenceChar) {
        inFence = false;
        fenceChar = null;
      }
      lines[index] = lines[index].replace(/[^\n]/g, ' ');
      continue;
    }
    if (inFence) lines[index] = lines[index].replace(/[^\n]/g, ' ');
  }
  return lines.join('\n');
}

function maskInlineCode(content) {
  return content.replace(/(`+)([\s\S]*?)\1/g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
}

function maskMarkdownCode(content) {
  return maskInlineCode(maskFencedBlocks(content));
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

/**
 * 提取 Markdown 链接：
 * - inline `[文字](路径)` / `![alt](路径)`
 * - reference-style 定义 `[label]: 路径` 与使用 `[文字][label]`
 * - HTML `<a href>` / `<img src>` 等 href/src 属性
 * code fence 与行内 code 中的内容不检查。
 */
export function extractMarkdownLinks(content) {
  const masked = maskMarkdownCode(content);
  const links = [];
  const seen = new Set();

  const add = (target, index, label = '') => {
    const value = String(target ?? '').trim();
    if (!value) return;
    const line = lineOf(masked, index);
    const key = `${line}\0${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ label, target: value, line });
  };

  const inlinePattern = /!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const match of masked.matchAll(inlinePattern)) {
    add(match[2], match.index ?? 0, match[1]);
  }

  const definitions = new Map();
  const definitionPattern = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+.*)?$/gm;
  for (const match of masked.matchAll(definitionPattern)) {
    const label = match[1].trim().toLowerCase();
    definitions.set(label, { target: match[2], index: match.index ?? 0 });
    add(match[2], match.index ?? 0, match[1]);
  }

  const referencePattern = /!?\[([^\]]*)\]\[([^\]]*)\]/g;
  for (const match of masked.matchAll(referencePattern)) {
    const label = (match[2] || match[1]).trim().toLowerCase();
    const definition = definitions.get(label);
    if (definition) add(definition.target, match.index ?? 0, match[1]);
  }

  const htmlPattern = /<[A-Za-z][^>]*?\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of masked.matchAll(htmlPattern)) {
    add(match[1] ?? match[2] ?? match[3], match.index ?? 0);
  }

  return links;
}

export function isExternalLink(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(String(target).trim());
}

/** 把文档内的相对链接解析成仓库相对路径；外链/纯锚点返回 null。 */
export function resolveRelativeLink(docPath, target) {
  const trimmed = String(target ?? '').trim();
  if (!trimmed || isExternalLink(trimmed)) return null;
  const withoutSuffix = trimmed.split('#')[0].split('?')[0];
  if (!withoutSuffix) return null;

  let decoded = withoutSuffix;
  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch {
    decoded = withoutSuffix;
  }

  if (decoded.startsWith('/')) return normalizeRepoPath(decoded.slice(1));
  return normalizeRepoPath(
    path.posix.join(path.posix.dirname(normalizeRepoPath(docPath)), decoded),
  );
}

export function findBrokenRelativeLinks(docPath, content, exists) {
  const broken = [];
  for (const link of extractMarkdownLinks(content)) {
    const resolvedPath = resolveRelativeLink(docPath, link.target);
    if (!resolvedPath) continue;
    if (!exists(resolvedPath)) {
      broken.push({ docPath, target: link.target, resolvedPath, line: link.line });
    }
  }
  return broken;
}

/* ------------------------------------------------------------------ *
 * 文档结构
 * ------------------------------------------------------------------ */

export function classifyDocPath(docPath) {
  const normalized = normalizeRepoPath(docPath);
  if (normalized === INDEX_DOC || normalized === 'docs/reviews/README.md') return 'living';
  if (/^docs\/reviews\/.+\.md$/.test(normalized)) return 'frozen';
  if (/^docs\/(?:standards|specs|architecture|guides|runbooks)\/.+\.md$/.test(normalized)) {
    return 'living';
  }
  return 'invalid';
}

export function isForbiddenDocName(docPath) {
  const baseName = path.posix
    .basename(normalizeRepoPath(docPath))
    .replace(/\.md$/i, '')
    .toLowerCase();
  const tokens = baseName.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  if (tokens.some((token) => FORBIDDEN_NAME_TOKENS.has(token))) return true;
  return FORBIDDEN_NAME_FRAGMENTS.some((fragment) => baseName.includes(fragment));
}

export function docLineLimit(docPath) {
  const normalized = normalizeRepoPath(docPath);
  if (/^docs\/guides\/[^/].*\.md$/i.test(normalized)) return GUIDE_LINE_LIMIT;
  if (/^docs\/runbooks\/[^/].*\.md$/i.test(normalized)) return RUNBOOK_LINE_LIMIT;
  if (/^docs\/(?:architecture|standards|specs)\/[^/].*\.md$/i.test(normalized)) {
    return DIR_LINE_LIMIT;
  }
  return INDEX_LINE_LIMIT;
}

function splitDocumentLines(content) {
  const lines = content.split(/\r?\n/);
  if (content.endsWith('\n') && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countH1Lines(lines) {
  let inFence = false;
  let count = 0;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#\s+\S/.test(line)) count += 1;
  }
  return count;
}

function firstH1Index(lines) {
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#\s+\S/.test(lines[index])) return index;
  }
  return -1;
}

/** 单份 living 文档的内容规则。 */
export function checkDocContent(docPath, content) {
  const normalized = normalizeRepoPath(docPath);
  const issues = [];
  const lines = splitDocumentLines(content);
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

  if (isForbiddenDocName(normalized)) {
    issues.push({
      code: 'forbidden-filename',
      severity: 'error',
      path: normalized,
      message: '文件名包含禁用标记（版本号/final/old/copy/tmp/draft/副本等），请使用稳定的单一文件名',
    });
  }

  if (nonEmptyLines.length < 5) {
    issues.push({
      code: 'empty-doc',
      severity: 'error',
      path: normalized,
      message: '文档内容过少（少于 5 个非空行），请补全或删除',
    });
  }

  const limit = docLineLimit(normalized);
  if (lines.length > limit) {
    issues.push({
      code: 'doc-too-long',
      severity: 'error',
      path: normalized,
      message: `文档 ${lines.length} 行，超过 ${limit} 行上限；请拆分或链接到专题文档`,
    });
  }

  const h1Count = countH1Lines(lines);
  if (h1Count === 0) {
    issues.push({
      code: 'missing-h1',
      severity: 'error',
      path: normalized,
      message: '文档缺少 H1 标题；每份 living 文档必须恰好有一个 H1',
    });
  } else if (h1Count > 1) {
    issues.push({
      code: 'duplicate-h1',
      severity: 'error',
      path: normalized,
      message: `文档包含 ${h1Count} 个 H1 标题，只允许一个`,
    });
  }

  const h1Index = firstH1Index(lines);
  if (h1Index >= 0) {
    let cursor = h1Index + 1;
    while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1;
    const firstParagraph = (lines[cursor] ?? '').trim();
    if (!/^>\s*结论[：:]/.test(firstParagraph)) {
      issues.push({
        code: 'missing-conclusion',
        severity: 'error',
        path: normalized,
        message: 'H1 后第一段必须以 `> 结论：` 开头，先给结论再展开',
      });
    }
  }

  return issues;
}

export function collectMarkdownFiles(root) {
  const docsRoot = path.join(root, 'docs');
  if (!fs.existsSync(docsRoot)) return [];
  const results = [];
  const walk = (absoluteDir, relativeDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingError(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) results.push(relativePath);
    }
  };
  walk(docsRoot, 'docs');
  return results.sort();
}

/** 索引必须直接链接每个 living 文档。 */
export function findUnindexedDocs(indexDocPath, indexContent, livingDocs) {
  const normalizedIndex = normalizeRepoPath(indexDocPath);
  const linked = new Set(
    extractMarkdownLinks(indexContent)
      .map((link) => resolveRelativeLink(normalizedIndex, link.target))
      .filter((target) => Boolean(target)),
  );
  return livingDocs
    .map(normalizeRepoPath)
    .filter((docPath) => docPath !== normalizedIndex && !linked.has(docPath));
}

/* ------------------------------------------------------------------ *
 * 代码注释与文档引用
 * ------------------------------------------------------------------ */

export function findDocReferencesInText(content) {
  const withoutUrls = content.replace(/https?:\/\/[^\s)）\]]+/g, '');
  const pattern = /docs\/[A-Za-z0-9_./\-\u4e00-\u9fff]+?\.md/g;
  const references = [];
  for (const match of withoutUrls.matchAll(pattern)) {
    references.push({
      docPath: normalizeRepoPath(match[0]),
      line: lineOf(withoutUrls, match.index ?? 0),
    });
  }
  return references;
}

function sectionNumberAfter(content, start) {
  const after = content.slice(start, start + 24);
  const match = after.match(/^\s*(?:§|Section\s+)\s*(\d+(?:\.\d+)*(?:-[A-Za-z]|[A-Za-z])?)/);
  return match ? match[1] : null;
}

/**
 * 提取 `docs/x.md §N` / `docs/x.md Section N` 形式的章节引用；
 * 传入 resolveBareDoc 时同时解析 `x.md §N` 这类裸文件名引用。
 */
export function findDocSectionReferencesInText(content, resolveBareDoc) {
  const withoutUrls = content.replace(/https?:\/\/[^\s)）\]]+/g, '');
  const references = [];

  const add = (docPath, section, index) => {
    references.push({
      sourcePath: '',
      docPath: normalizeRepoPath(docPath),
      section,
      line: lineOf(withoutUrls, index),
    });
  };

  const fullPathPattern = /docs\/[A-Za-z0-9_./\-\u4e00-\u9fff]+?\.md/g;
  for (const match of withoutUrls.matchAll(fullPathPattern)) {
    const section = sectionNumberAfter(withoutUrls, (match.index ?? 0) + match[0].length);
    if (section) add(match[0], section, match.index ?? 0);
  }

  if (resolveBareDoc) {
    const bareNamePattern =
      /(?<![\w/.-])([A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_.\-\u4e00-\u9fff]*\.md)/g;
    for (const match of withoutUrls.matchAll(bareNamePattern)) {
      const resolved = resolveBareDoc(match[1]);
      if (!resolved) continue;
      const section = sectionNumberAfter(withoutUrls, (match.index ?? 0) + match[0].length);
      if (section) add(resolved, section, match.index ?? 0);
    }
  }

  return references.sort((left, right) => left.line - right.line);
}

/** 提取 Markdown 链接上的章节引用：`[文档](x.md) §N` 与 `[文档 §N](x.md)`。 */
export function findMarkdownLinkSectionReferences(docPath, content) {
  const references = [];
  const add = (target, section, index) => {
    const resolved = resolveRelativeLink(docPath, target);
    if (!resolved) return;
    references.push({
      sourcePath: docPath,
      docPath: resolved,
      section,
      line: lineOf(content, index),
    });
  };

  const afterLinkPattern =
    /\[[^\]]*\]\(\s*<?([^)\s>]+\.md)(?:#[^)]*)?>?(?:\s+["'][^"']*["'])?\s*\)\s*(?:§|Section\s+)\s*(\d+(?:\.\d+)*(?:-[A-Za-z]|[A-Za-z])?)/g;
  for (const match of content.matchAll(afterLinkPattern)) {
    add(match[1], match[2], match.index ?? 0);
  }

  const sectionInLabelPattern =
    /\[[^\]]*?§\s*(\d+(?:\.\d+)*(?:-[A-Za-z]|[A-Za-z])?)[^\]]*\]\(\s*<?([^)\s>]+\.md)(?:#[^)]*)?>?(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const match of content.matchAll(sectionInLabelPattern)) {
    add(match[2], match[1], match.index ?? 0);
  }

  return references.sort((left, right) => left.line - right.line);
}

/** 收集 Markdown 标题里的章节号，并补齐祖先章节（3.1 也代表 3 存在）。 */
export function collectDocSections(content) {
  const sections = new Set();
  let currentSection = null;
  for (const line of content.split(/\r?\n/)) {
    const heading = line.match(
      /^#{2,6}\s+(\d+(?:\.\d+)*(?:-[A-Za-z]|[A-Za-z])?)(?:[.、]|\s)/,
    );
    if (heading) {
      const raw = heading[1];
      const numeric = raw.match(/^\d+(?:\.\d+)*/)?.[0] ?? raw;
      const parts = numeric.split('.');
      for (let index = 1; index <= parts.length; index += 1) {
        sections.add(parts.slice(0, index).join('.'));
      }
      if (raw !== numeric) sections.add(raw);
      currentSection = raw;
      continue;
    }
    const label = line.match(/^\*\*([A-Z])[.、]\s/);
    if (label && currentSection) sections.add(`${currentSection}-${label[1]}`);
  }
  return sections;
}

export function findMissingDocSections(files, readDoc, resolveBareDoc) {
  const missing = [];
  const cache = new Map();
  for (const file of files) {
    const commentText = commentTextForSourceFile(file.path, file.content);
    for (const reference of findDocSectionReferencesInText(commentText, resolveBareDoc)) {
      if (!cache.has(reference.docPath)) {
        const content = readDoc(reference.docPath);
        cache.set(reference.docPath, content === null ? null : collectDocSections(content));
      }
      const sections = cache.get(reference.docPath);
      if (sections === null || sections === undefined) continue;
      if (!sections.has(reference.section)) {
        missing.push({ ...reference, sourcePath: file.path });
      }
    }
  }
  return missing;
}

/* ------------------------------------------------------------------ *
 * 源码注释掩码
 * ------------------------------------------------------------------ */

function maskNonNewline(text) {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * 只保留 C 系注释文本；代码、字符串、模板字符串等替换为等长空白，行号不变。
 * 覆盖 .ts/.js、.kt/.kts、.java、.m/.mm/.h、.swift、.ets、.gradle：
 * - 行注释 `//` 与块注释 `/* ... *\/`；
 * - 单/双引号、反引号字符串内的 `//` 与路径不算注释；
 * - Kotlin/Swift 三引号原始字符串 `"""..."""` 整体视为字符串，
 *   避免其中顶格书写的 `// docs/...` 被误判成注释。
 */
function maskCStyleComments(source) {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end < 0 ? source.length : end;
      output += source.slice(index, stop);
      index = stop;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end < 0 ? source.length : end + 2;
      output += source.slice(index, stop);
      index = stop;
      continue;
    }

    if (char === '"' && source.startsWith('"""', index)) {
      const end = source.indexOf('"""', index + 3);
      const stop = end < 0 ? source.length : end + 3;
      output += maskNonNewline(source.slice(index, stop));
      index = stop;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      output += maskNonNewline(source.slice(index, cursor));
      index = cursor;
      continue;
    }

    output += char === '\n' ? '\n' : ' ';
    index += 1;
  }
  return output;
}

/** XML/.plist/.html：只保留 `<!-- -->` 注释，属性值、文本节点与 CDATA 一律屏蔽。 */
function maskMarkupComments(source) {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('<!--', index);
    if (open < 0) {
      output += maskNonNewline(source.slice(index));
      break;
    }
    output += maskNonNewline(source.slice(index, open));
    const end = source.indexOf('-->', open + 4);
    const stop = end < 0 ? source.length : end + 3;
    output += source.slice(open, stop);
    index = stop;
  }
  return output;
}

/** CSS：只保留块注释，声明值与字符串里的 `docs/` 路径不算注释。 */
function maskCssComments(source) {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];

    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end < 0 ? source.length : end + 2;
      output += source.slice(index, stop);
      index = stop;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      output += maskNonNewline(source.slice(index, cursor));
      index = cursor;
      continue;
    }

    output += char === '\n' ? '\n' : ' ';
    index += 1;
  }
  return output;
}

function maskHashComments(source) {
  const lines = source.split('\n');
  return lines
    .map((line) => {
      let quote = null;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '\\' && quote) {
          index += 1;
          continue;
        }
        if (quote) {
          if (char === quote) quote = null;
          continue;
        }
        if (char === '"' || char === "'") {
          quote = char;
          continue;
        }
        if (char === '#') return `${' '.repeat(index)}${line.slice(index)}`;
      }
      return maskNonNewline(line);
    })
    .join('\n');
}

function maskSqlComments(source) {
  const lines = source.split('\n');
  return lines
    .map((line) => {
      const commentIndex = line.indexOf('--');
      if (commentIndex < 0) return maskNonNewline(line);
      return `${' '.repeat(commentIndex)}${line.slice(commentIndex)}`;
    })
    .join('\n');
}

const TYPESCRIPT_LIKE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const C_FAMILY_EXTENSIONS = new Set([
  '.kt',
  '.kts',
  '.java',
  '.m',
  '.mm',
  '.h',
  '.swift',
  '.ets',
  '.gradle',
]);
const MARKUP_EXTENSIONS = new Set(['.xml', '.plist', '.html']);
const HASH_COMMENT_EXTENSIONS = new Set([
  '.py',
  '.sh',
  '.bash',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.conf',
  '.example',
]);

function commentTextForSourceFile(fileName, content) {
  const extension = path.extname(fileName).toLowerCase();
  if (TYPESCRIPT_LIKE_EXTENSIONS.has(extension) || C_FAMILY_EXTENSIONS.has(extension)) {
    return maskCStyleComments(content);
  }
  if (MARKUP_EXTENSIONS.has(extension)) return maskMarkupComments(content);
  if (extension === '.css') return maskCssComments(content);
  if (extension === '.sql') return maskSqlComments(content);
  if (HASH_COMMENT_EXTENSIONS.has(extension) || path.basename(fileName) === 'Dockerfile') {
    return maskHashComments(content);
  }
  return content;
}

function isScannableSourceFile(fileName) {
  return SOURCE_EXTENSIONS.has(path.extname(fileName).toLowerCase())
    || fileName === 'Dockerfile';
}

/**
 * 从 git tracked 文件里收集源码文本。
 * 全量检查只扫描 tracked 文件；docs/ 目录由文档检查单独处理，避免重复。
 */
export function collectSourceTextFiles(root, trackedFiles) {
  const results = [];
  for (const candidate of trackedFiles ?? []) {
    const relativePath = normalizeRepoPath(candidate);
    if (relativePath.startsWith('docs/')) continue;
    const parts = relativePath.split('/');
    if (parts.some((part) => SKIP_SOURCE_DIRS.has(part))) continue;
    if (SKIP_SOURCE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) continue;
    if (!isScannableSourceFile(path.posix.basename(relativePath))) continue;

    const absolutePath = path.join(root, ...relativePath.split('/'));
    let stat;
    try {
      stat = fs.statSync(absolutePath);
    } catch (error) {
      if (isMissingError(error)) continue;
      throw error;
    }
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
    let content;
    try {
      content = fs.readFileSync(absolutePath, 'utf8');
    } catch (error) {
      if (isMissingError(error)) continue;
      throw error;
    }
    if (content.includes('\0')) continue;
    results.push({ path: relativePath, content });
  }
  return results;
}

export function findMissingDocReferences(files, exists) {
  const missing = [];
  for (const file of files) {
    const commentText = commentTextForSourceFile(file.path, file.content);
    for (const reference of findDocReferencesInText(commentText)) {
      if (!exists(reference.docPath)) {
        missing.push({
          sourcePath: file.path,
          docPath: reference.docPath,
          line: reference.line,
        });
      }
    }
  }
  return missing;
}

/* ------------------------------------------------------------------ *
 * doc-map
 * ------------------------------------------------------------------ */

export function parseDocMap(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`doc-map.json 不是合法 JSON：${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rules)) {
    throw new Error('doc-map.json 缺少 rules 数组');
  }

  const rules = parsed.rules.map((rule, index) => {
    if (
      !rule
      || typeof rule !== 'object'
      || !Array.isArray(rule.include)
      || !Array.isArray(rule.docs)
      || (rule.mode !== 'require' && rule.mode !== 'warn')
    ) {
      throw new Error(
        `doc-map.json 第 ${index + 1} 条规则格式错误：include/docs 必须是数组，mode 必须是 require 或 warn`,
      );
    }
    if (rule.exclude !== undefined && !Array.isArray(rule.exclude)) {
      throw new Error(`doc-map.json 第 ${index + 1} 条规则的 exclude 必须是数组`);
    }
    return {
      include: rule.include.map(String),
      exclude: (rule.exclude ?? []).map(String),
      docs: rule.docs.map(String),
      mode: rule.mode,
      reason: typeof rule.reason === 'string' ? rule.reason.trim() : '',
    };
  });

  /**
   * rangeBaseline：一次性初始化边界。存在且有效时，range 只检查该提交之后的提交，
   * 避免把初始化历史（例如冻结证据迁移）反噬到新门禁；基线之后仍逐提交检查。
   * 必须是完整 40 位 commit SHA；格式非法视为 doc-map 配置错误（CLI 退出 2）。
   */
  let rangeBaseline;
  if (parsed.rangeBaseline !== undefined) {
    const raw = parsed.rangeBaseline;
    if (typeof raw !== 'string' || !/^[0-9a-f]{40}$/i.test(raw.trim())) {
      throw new Error('doc-map.json 的 rangeBaseline 必须是 40 位十六进制 commit SHA');
    }
    rangeBaseline = raw.trim();
  }

  return { version: parsed.version, rangeBaseline, rules };
}

/** doc-map 的每个目标都必须是已存在的 living 文档，且每条规则不能是死 glob。 */
export function validateDocMap(docMap, exists, knownFiles) {
  const issues = [];
  if (!docMap || !Array.isArray(docMap.rules) || docMap.rules.length === 0) {
    issues.push({
      code: 'empty-doc-map',
      severity: 'error',
      path: DOC_MAP_PATH,
      message: 'doc-map 至少需要一条规则；空规则表会让门禁全部失效',
    });
    return issues;
  }

  docMap.rules.forEach((rule, index) => {
    const label = rule.reason || `第 ${index + 1} 条规则`;

    if (rule.include.length === 0 || rule.docs.length === 0) {
      issues.push({
        code: 'empty-doc-map-rule',
        severity: 'error',
        path: DOC_MAP_PATH,
        message: `规则「${label}」的 include 或 docs 为空，永远不会触发`,
      });
    }

    if (!rule.reason) {
      issues.push({
        code: 'empty-doc-map-rule',
        severity: 'error',
        path: DOC_MAP_PATH,
        message: `规则「第 ${index + 1} 条规则」缺少 reason（原因/理由），必须说明为什么属于契约面`,
      });
    }

    if (knownFiles && rule.include.length > 0 && rule.docs.length > 0) {
      if (!knownFiles.some((file) => matchesRule(file, rule))) {
        issues.push({
          code: 'dead-doc-map-rule',
          severity: 'error',
          path: DOC_MAP_PATH,
          message: `规则「${label}」的 include 没有任何匹配文件，可能是死 glob`,
        });
      }
    }

    for (const docPath of rule.docs) {
      const normalized = normalizeRepoPath(docPath);
      if (!exists(normalized)) {
        issues.push({
          code: 'missing-doc-map-target',
          severity: 'error',
          path: DOC_MAP_PATH,
          message: `规则「${label}」映射的文档不存在：${normalized}`,
        });
        continue;
      }
      if (classifyDocPath(normalized) !== 'living') {
        issues.push({
          code: 'invalid-doc-map-target',
          severity: 'error',
          path: DOC_MAP_PATH,
          message: `规则「${label}」映射的目标不是 living 文档：${normalized}`,
        });
      }
    }
  });

  return issues;
}

/* ------------------------------------------------------------------ *
 * 全量校验
 * ------------------------------------------------------------------ */

/**
 * 全量校验 docs 目录。
 * options.knownFiles 必须是 git tracked 文件列表（doc-map 死规则只用 tracked）。
 */
export function validateDocs(root, options = {}) {
  const docsRoot = path.join(root, 'docs');
  if (!fs.existsSync(docsRoot)) {
    return [{
      code: 'missing-docs',
      severity: 'error',
      path: 'docs',
      message: 'docs 目录不存在',
    }];
  }

  const issues = [];
  const markdownFiles = collectMarkdownFiles(root);
  const livingDocs = [];
  const livingByBasename = new Map();
  const ambiguousBasenames = new Set();

  for (const candidate of markdownFiles) {
    if (classifyDocPath(candidate) !== 'living') continue;
    const baseName = path.posix.basename(candidate);
    if (livingByBasename.has(baseName)) ambiguousBasenames.add(baseName);
    else livingByBasename.set(baseName, candidate);
  }

  const resolveBareDoc = (fileName) => {
    const baseName = path.posix.basename(normalizeRepoPath(fileName));
    if (ambiguousBasenames.has(baseName)) return null;
    return livingByBasename.get(baseName) ?? null;
  };

  const readDocContent = (docPath) => {
    if (!existsWithExactCase(root, docPath)) return null;
    try {
      return fs.readFileSync(path.join(root, ...docPath.split('/')), 'utf8');
    } catch (error) {
      if (isMissingError(error)) return null;
      throw error;
    }
  };

  for (const docPath of markdownFiles) {
    const docClass = classifyDocPath(docPath);
    if (docClass === 'invalid') {
      issues.push({
        code: 'invalid-location',
        severity: 'error',
        path: docPath,
        message: '文档不在允许目录（仅 standards/specs/architecture/guides/runbooks 与两个 README）；请移到正确目录或删除',
      });
      continue;
    }
    if (docClass === 'frozen') continue;

    livingDocs.push(docPath);
    const content = fs.readFileSync(path.join(root, ...docPath.split('/')), 'utf8');

    issues.push(...checkDocContent(docPath, content));

    const linkedTargets = new Set(
      extractMarkdownLinks(content)
        .map((link) => resolveRelativeLink(docPath, link.target))
        .filter((target) => Boolean(target)),
    );

    for (const reference of findDocReferencesInText(content)) {
      if (linkedTargets.has(reference.docPath)) continue;
      if (!existsWithExactCase(root, reference.docPath)) {
        issues.push({
          code: 'missing-doc-reference',
          severity: 'error',
          path: docPath,
          line: reference.line,
          message: `文档引用的文档不存在：${reference.docPath}`,
        });
      }
    }

    for (const broken of findBrokenRelativeLinks(
      docPath,
      content,
      (target) => existsWithExactCase(root, target),
    )) {
      issues.push({
        code: 'broken-link',
        severity: 'error',
        path: docPath,
        line: broken.line,
        message: `相对链接不存在：${broken.target} → ${broken.resolvedPath}`,
      });
    }

    for (const reference of findMissingDocSections(
      [{ path: docPath, content }],
      readDocContent,
      resolveBareDoc,
    )) {
      issues.push({
        code: 'missing-doc-section',
        severity: 'error',
        path: docPath,
        line: reference.line,
        message: `文档引用的章节不存在：${reference.docPath} §${reference.section}`,
      });
    }

    for (const reference of findMissingMarkdownLinkSections(
      docPath,
      content,
      readDocContent,
    )) {
      issues.push({
        code: 'missing-doc-section',
        severity: 'error',
        path: docPath,
        line: reference.line,
        message: `文档链接引用的章节不存在：${reference.docPath} §${reference.section}`,
      });
    }
  }

  const indexPath = INDEX_DOC;
  if (!existsWithExactCase(root, indexPath)) {
    issues.push({
      code: 'missing-index',
      severity: 'error',
      path: indexPath,
      message: '缺少唯一入口 docs/README.md',
    });
  } else {
    const indexContent = fs.readFileSync(path.join(root, 'docs', 'README.md'), 'utf8');
    const indexedDocs = livingDocs.filter((docPath) => docPath !== indexPath);
    for (const orphan of findUnindexedDocs(indexPath, indexContent, indexedDocs)) {
      issues.push({
        code: 'unindexed-doc',
        severity: 'error',
        path: orphan,
        message: `文档未被 ${indexPath} 直接链接，请更新索引`,
      });
    }
  }

  const runbooks = livingDocs.filter(
    (docPath) => /^docs\/runbooks\/[^/]+\.md$/.test(docPath) && docPath !== RUNBOOK_INDEX,
  );
  if (runbooks.length > 0) {
    if (!existsWithExactCase(root, RUNBOOK_INDEX)) {
      issues.push({
        code: 'missing-index',
        severity: 'error',
        path: RUNBOOK_INDEX,
        message: '缺少 docs/runbooks/README.md 二级索引',
      });
    } else {
      const runbookIndexContent = fs.readFileSync(
        path.join(root, ...RUNBOOK_INDEX.split('/')),
        'utf8',
      );
      const linkedRunbooks = new Set(
        extractMarkdownLinks(runbookIndexContent)
          .map((link) => resolveRelativeLink(RUNBOOK_INDEX, link.target))
          .filter((target) => Boolean(target)),
      );
      for (const runbook of runbooks) {
        if (linkedRunbooks.has(runbook)) continue;
        issues.push({
          code: 'unindexed-runbook',
          severity: 'error',
          path: runbook,
          message: `runbook 未登记到 ${RUNBOOK_INDEX}，请更新二级索引`,
        });
      }
    }
  }

  if (options.docMap) {
    issues.push(
      ...validateDocMap(
        options.docMap,
        (docPath) => existsWithExactCase(root, docPath),
        options.knownFiles,
      ),
    );
  }

  const sourceFiles = collectSourceTextFiles(root, options.knownFiles ?? []);
  for (const reference of findMissingDocReferences(sourceFiles, (docPath) =>
    existsWithExactCase(root, docPath),
  )) {
    issues.push({
      code: 'missing-code-doc',
      severity: 'error',
      path: reference.sourcePath,
      line: reference.line,
      message: `代码引用的文档不存在：${reference.docPath}`,
    });
  }
  for (const reference of findMissingDocSections(sourceFiles, readDocContent, resolveBareDoc)) {
    issues.push({
      code: 'missing-doc-section',
      severity: 'error',
      path: reference.sourcePath,
      line: reference.line,
      message: `代码引用的文档章节不存在：${reference.docPath} §${reference.section}`,
    });
  }

  return issues;
}

export function findMissingMarkdownLinkSections(docPath, content, readDoc) {
  const missing = [];
  for (const reference of findMarkdownLinkSectionReferences(docPath, content)) {
    const target = readDoc(reference.docPath);
    if (target === null) continue;
    if (!collectDocSections(target).has(reference.section)) missing.push(reference);
  }
  return missing;
}
