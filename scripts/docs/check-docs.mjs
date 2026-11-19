#!/usr/bin/env node
/**
 * docs 检查器 CLI。
 *
 * 模式：
 * - 默认全量检查工作区；
 * - `--staged` 检查索引里的代码变更是否同步了映射文档；
 * - `--range [<base>..<head>]` 逐提交检查一个提交范围（默认 origin/main..HEAD，
 *   回退 main..HEAD），供 pre-push 与 CI 阻止 `--no-verify` 绕过。
 *
 * 退出码：
 * - 0：通过，或按 DOCS_CHECK=off 显式跳过（range 模式不接受该开关）；
 * - 1：校验失败（结构/索引/链接/命名/行数/doc-map/staged/range 缺文档）；
 * - 2：工具或配置错误（非 git、缺 docs/、缺/损坏 doc-map、未知参数、基线缺失、
 *   Node 版本不足、无法读取 git 对象）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeStagedImpact,
  evaluateRangeCommits,
  existsWithExactCase,
  normalizeRepoPath,
  parseDocMap,
  validateDocMap,
  validateDocs,
} from './doc-lib.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DOC_MAP_PATH = 'docs/doc-map.json';
const MIN_NODE_MAJOR = 22;

const JSON_OUTPUT = { pretty: true };

function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(SCRIPT_PATH);
  } catch {
    return path.resolve(entry) === path.resolve(SCRIPT_PATH);
  }
}

function jsonModeOf(args) {
  if (args.includes('--range')) return 'range';
  return args.includes('--staged') ? 'staged' : 'full';
}

/**
 * 参数解析：`--range` 接受一个可选的 `<base>..<head>` 值。
 * 值缺失或下一项仍是选项时，使用默认基线。
 */
function parseArgs(argv) {
  const options = { staged: false, json: false, range: undefined, rangeRequested: false };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (arg === '--staged') {
      options.staged = true;
      index += 1;
      continue;
    }
    if (arg === '--range') {
      options.rangeRequested = true;
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options.range = next;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    throw new Error(`未知参数：${arg}；仅支持 --staged、--range [<base>..<head>]、--json`);
  }

  if (options.staged && options.rangeRequested) {
    throw new Error('--range 不能与 --staged 同用：range 检查历史提交，staged 检查索引');
  }
  return options;
}

function printJson(report) {
  console.log(JSON.stringify(report, null, JSON_OUTPUT.pretty ? 2 : 0));
}

function assertNodeVersion() {
  const raw = process.versions?.node ?? process.version ?? '0.0.0';
  const major = Number.parseInt(String(raw).replace(/^v/, '').split('.')[0], 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new Error(
      `Node.js 版本过低：需要 >= ${MIN_NODE_MAJOR}，当前 ${process.version ?? raw}`,
    );
  }
}

function findRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error('当前目录不是 git 仓库，无法执行文档检查');
  }
}

function loadDocMap(root) {
  const absolutePath = path.join(root, DOC_MAP_PATH);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`缺少 ${DOC_MAP_PATH}；无法计算代码与文档的映射关系`);
  }
  return parseDocMap(fs.readFileSync(absolutePath, 'utf8'));
}

function trackedFiles(root) {
  const output = execFileSync('git', ['ls-files', '-z', '--cached'], {
    cwd: root,
    encoding: 'utf8',
  });
  return output.split('\0').filter(Boolean);
}

function isIgnoredPath(root, repoPath) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', repoPath], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function stagedEntries(root) {
  let output;
  try {
    output = execFileSync(
      'git',
      ['diff', '--cached', '--name-status', '--diff-filter=ACMRD', '--no-renames', '-z'],
      { cwd: root, encoding: 'utf8' },
    );
  } catch (error) {
    throw new Error(`无法读取 staged 文件（需要在 git 仓库中运行）：${String(error)}`);
  }

  const fields = output.split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    entries.push({ status: fields[index], path: fields[index + 1] });
  }
  return entries;
}

/**
 * 全量检查读取工作区，而提交内容来自 index。两者对同一路径不一致时，
 * 检查结果不能代表将要提交的树，必须先让用户把改动收敛到 index。
 */
function findStagedWorktreeDivergence(root, entries) {
  if (entries.length === 0) return [];
  const issues = [];
  const deleted = entries.filter((entry) => entry.status.startsWith('D'));
  const present = entries.filter((entry) => !entry.status.startsWith('D'));

  for (const entry of deleted) {
    const repoPath = normalizeRepoPath(entry.path);
    if (
      fs.existsSync(path.join(root, ...repoPath.split('/')))
      && !isIgnoredPath(root, repoPath)
    ) {
      issues.push({
        code: 'staged-worktree-divergence',
        severity: 'error',
        path: repoPath,
        message:
          '该文件已从 index 删除，但工作区仍存在；文档检查读取工作区，无法代表将要提交的内容。请同步删除本地文件（或移出 docs/）后重试',
      });
    }
  }

  if (present.length > 0) {
    const output = execFileSync(
      'git',
      ['diff', '--name-only', '--no-renames', '-z', '--', ...present.map((entry) => entry.path)],
      { cwd: root, encoding: 'utf8' },
    );
    for (const file of output.split('\0').filter(Boolean)) {
      issues.push({
        code: 'staged-worktree-divergence',
        severity: 'error',
        path: normalizeRepoPath(file),
        message:
          '该文件已暂存但工作区仍有未暂存改动；文档检查读取工作区，无法代表将要提交的内容。请先 git add 该文件（或暂存全部改动）后重试',
      });
    }
  }
  return issues;
}

function printIssue(issue) {
  const location = issue.path ? (issue.line ? `${issue.path}:${issue.line}` : issue.path) : '-';
  console.error(`[${issue.code}] ${location}  ${issue.message}`);
}

function printFullResult(issues) {
  for (const issue of issues) printIssue(issue);
  if (issues.length === 0) {
    console.log('文档检查通过：目录结构、索引、链接与代码引用均有效。');
    return;
  }
  const counts = new Map();
  for (const issue of issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  const summary = [...counts.entries()].map(([code, count]) => `${code}=${count}`).join('，');
  console.error(`\n文档检查未通过：共 ${issues.length} 个问题（${summary}）。`);
}

function printImpact(impact, kind) {
  const label = kind === 'failure' ? '失败' : '提醒';
  console.error(`\n[${label}] ${impact.rule.reason}`);
  console.error('  改动代码：');
  for (const file of impact.codeFiles) console.error(`    - ${file}`);
  console.error('  应更新以下文档之一：');
  for (const doc of impact.rule.docs) console.error(`    - ${doc}`);
}

function printStagedResult(result) {
  for (const warning of result.warnings) printImpact(warning, 'warning');
  for (const failure of result.failures) printImpact(failure, 'failure');

  if (!result.ok) {
    console.error(`\n文档检查未通过：${result.failures.length} 个代码域缺少对应文档更新。`);
    return;
  }
  if (result.warnings.length > 0) {
    console.warn(`\n文档检查通过，但有 ${result.warnings.length} 条文档更新提醒。`);
    return;
  }
  if (result.impacts.length === 0) {
    console.log('文档检查通过：本次 staged 变更未命中代码域映射。');
    return;
  }
  console.log(`文档检查通过：${result.impacts.length} 个代码域已同步更新文档。`);
}

function runFull(root, json) {
  const docMap = loadDocMap(root);
  const knownFiles = trackedFiles(root);
  const issues = validateDocs(root, { docMap, knownFiles });
  if (json) printJson({ mode: 'full', ok: issues.length === 0, issues });
  else printFullResult(issues);
  return issues.length === 0 ? 0 : 1;
}

function runStaged(root, json) {
  const docMap = loadDocMap(root);
  const knownFiles = trackedFiles(root);
  const docMapIssues = validateDocMap(
    docMap,
    (docPath) => existsWithExactCase(root, docPath),
    knownFiles,
  );

  if (docMapIssues.length > 0) {
    if (json) {
      printJson({
        mode: 'staged',
        ok: false,
        issues: docMapIssues,
        failures: [],
        warnings: [],
        impacts: [],
      });
    } else {
      printFullResult(docMapIssues);
    }
    return 1;
  }

  const entries = stagedEntries(root);
  const divergenceIssues = findStagedWorktreeDivergence(root, entries);
  if (divergenceIssues.length > 0) {
    if (json) {
      printJson({
        mode: 'staged',
        ok: false,
        issues: divergenceIssues,
        failures: [],
        warnings: [],
        impacts: [],
      });
    } else {
      printFullResult(divergenceIssues);
    }
    return 1;
  }

  const result = computeStagedImpact(entries, docMap.rules);
  if (json) {
    printJson({
      mode: 'staged',
      ok: result.ok,
      failures: result.failures,
      warnings: result.warnings,
      impacts: result.impacts,
    });
  } else {
    printStagedResult(result);
  }
  return result.ok ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * --range：逐提交检查
 * ------------------------------------------------------------------ */

function gitCapture(root, args, failureMessage) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error && error.message ? `：${error.message}` : '';
    throw new Error(`${failureMessage}${detail}`);
  }
}

function commitExists(root, rev) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析提交范围，优先级：
 * 1. 显式 `--range <base>..<head>`（head 省略时取 HEAD，base 必填）；
 * 2. doc-map 顶层 `rangeBaseline`：一次性初始化边界，只检查该提交之后；
 * 3. 默认 `origin/main..HEAD`，回退 `main..HEAD`；
 * 基线字段存在但指向不存在的提交 → 2；三种来源都不可用时也 → 2，不得放行。
 */
function resolveRange(root, spec, docMap) {
  if (spec !== undefined) {
    const trimmed = String(spec).trim();
    const match = /^([^\s]+?)\.\.([^\s]*)$/.exec(trimmed);
    if (!match) {
      throw new Error(
        `--range 参数格式错误：${trimmed || '(空)'}；期望 <base>..<head>（head 省略时取 HEAD）`,
      );
    }
    const base = match[1];
    const head = match[2] || 'HEAD';
    if (!commitExists(root, base)) throw new Error(`--range 的 base 提交不存在：${base}`);
    if (!commitExists(root, head)) throw new Error(`--range 的 head 提交不存在：${head}`);
    return { base, head, label: `${base}..${head}` };
  }

  const baseline = docMap?.rangeBaseline;
  if (baseline !== undefined) {
    if (!commitExists(root, baseline)) {
      throw new Error(`doc-map.json 的 rangeBaseline 不是仓库内提交：${baseline}`);
    }
    return { base: baseline, head: 'HEAD', label: `${baseline}..HEAD` };
  }

  const base = ['origin/main', 'main'].find((candidate) => commitExists(root, candidate));
  if (!base) {
    throw new Error(
      '无法确定文档检查基线：doc-map 无 rangeBaseline，且 origin/main 与 main 都不存在；请显式传入 --range <base>..<head>',
    );
  }
  return { base, head: 'HEAD', label: `${base}..HEAD` };
}

/**
 * 枚举范围提交（含 merge commit）：每项带 parents，供 merge 的 first-parent diff 使用。
 * 不能用 `--no-merges`，否则冲突解决时夹带的改动会成为盲区。
 */
function listRangeCommits(root, range) {
  const output = gitCapture(
    root,
    ['rev-list', '--reverse', '--parents', `${range.base}..${range.head}`],
    `无法枚举提交范围 ${range.label}`,
  );
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [commit, ...parents] = line.split(/\s+/);
      return { commit, parents };
    });
}

function commitMessage(root, commit) {
  return gitCapture(root, ['log', '-1', '--format=%B', commit], `无法读取提交信息 ${commit}`);
}

/**
 * 取一次提交的文件变更，输出为 STATUS\0PATH\0 交替序列。
 * - 普通提交：`--root <commit>`，根提交也被计算；
 * - merge commit：对第一父做 diff，检查冲突解决时引入的改动。
 */
function commitEntries(root, commit, parents) {
  const args = ['diff-tree', '--no-commit-id', '--name-status', '--no-renames', '-r', '-z'];
  if (parents.length >= 2) args.push(parents[0], commit);
  else args.push('--root', commit);

  const output = gitCapture(root, args, `无法读取提交 ${commit} 的文件变更`);
  const fields = output.split('\0').filter((field) => field.length > 0);
  const entries = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    entries.push({ status: fields[index], path: fields[index + 1] });
  }
  return entries;
}

function printRangeImpact(impact, kind) {
  const label = kind === 'failure' ? '失败' : '提醒';
  const short = String(impact.commit).slice(0, 12);

  if (impact.code === 'frozen-evidence-modified') {
    console.error(`\n[${label}] ${short} ${impact.subject}`);
    console.error('  冻结证据 docs/reviews/** 与 docs/superpowers/** 只读，该提交改动了：');
    for (const frozenPath of impact.paths) console.error(`    - ${frozenPath}`);
    return;
  }

  console.error(`\n[${label}] ${short} ${impact.subject}`);
  console.error(`  ${impact.rule.reason}`);
  console.error('  改动代码：');
  for (const file of impact.codeFiles) console.error(`    - ${file}`);
  console.error('  应更新以下文档之一：');
  for (const doc of impact.rule.docs) console.error(`    - ${doc}`);
}

function printRangeResult(report) {
  for (const warning of report.warnings) printRangeImpact(warning, 'warning');
  for (const failure of report.failures) printRangeImpact(failure, 'failure');

  if (report.failures.length > 0) {
    console.error(
      `\n文档检查未通过：范围 ${report.range} 内 ${report.failures.length} 个提交命中 require 规则但未更新映射文档。`,
    );
    return;
  }
  if (report.warnings.length > 0) {
    console.warn(
      `\n文档检查通过，但有 ${report.warnings.length} 条文档更新提醒（范围 ${report.range}）。`,
    );
    return;
  }
  if (report.commits.length === 0) {
    console.log(`文档检查通过：范围 ${report.range} 内没有需要检查的提交。`);
    return;
  }
  console.log(
    `文档检查通过：范围 ${report.range} 内 ${report.commits.length} 个提交均已同步文档。`,
  );
}

function runRange(root, json, rangeSpec) {
  const docMap = loadDocMap(root);
  if (docMap.rules.length === 0) {
    throw new Error('doc-map 规则为空，range 检查无法判断代码与文档的映射');
  }

  const range = resolveRange(root, rangeSpec, docMap);
  const commits = listRangeCommits(root, range);
  const items = commits.map((entry) => {
    const message = commitMessage(root, entry.commit);
    return {
      commit: entry.commit,
      subject: message.split('\n')[0].trim(),
      message,
      entries: commitEntries(root, entry.commit, entry.parents),
    };
  });

  const result = evaluateRangeCommits(items, docMap.rules);
  const report = {
    mode: 'range',
    ok: result.ok,
    range: range.label,
    commits: result.commits,
    failures: result.failures,
    warnings: result.warnings,
  };

  if (json) printJson(report);
  else printRangeResult(report);
  return report.ok ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  const modeGuess = jsonModeOf(args);
  const json = args.includes('--json');

  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printJson({ mode: modeGuess, ok: false, error: message });
    else console.error(message);
    process.exitCode = 2;
    return;
  }

  const mode = options.rangeRequested ? 'range' : options.staged ? 'staged' : 'full';

  try {
    assertNodeVersion();

    // 显式跳过只覆盖 full/staged；range 是防绕过门禁，必须忽略该开关。
    if (mode !== 'range' && (process.env.DOCS_CHECK ?? '').trim().toLowerCase() === 'off') {
      const reason =
        'DOCS_CHECK=off，已跳过文档检查；请确认本次改动确实无需更新文档，并在 commit message 中说明理由。';
      if (json) printJson({ mode, ok: true, skipped: true, reason });
      else console.log(reason);
      return;
    }

    const root = findRepoRoot();
    if (!fs.existsSync(path.join(root, 'docs'))) {
      throw new Error('缺少 docs/ 目录，无法执行文档检查');
    }

    if (mode === 'range') {
      process.exitCode = runRange(root, json, options.range);
    } else if (mode === 'staged') {
      process.exitCode = runStaged(root, json);
    } else {
      process.exitCode = runFull(root, json);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printJson({ mode, ok: false, error: message });
    else console.error(`文档检查无法执行：${message}`);
    process.exitCode = 2;
  }
}

if (isEntryPoint()) {
  main();
}
