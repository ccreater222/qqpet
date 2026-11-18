#!/usr/bin/env node
/**
 * docs 检查器 CLI。
 *
 * 退出码：
 * - 0：通过，或按 DOCS_CHECK=off 显式跳过；
 * - 1：校验失败（结构/索引/链接/命名/行数/doc-map/staged 缺文档）；
 * - 2：工具或配置错误（非 git、缺 docs/、缺/损坏 doc-map、未知参数、Node 版本不足）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeStagedImpact,
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

function jsonModeOf(args) {
  return args.includes('--staged') ? 'staged' : 'full';
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

function main() {
  const args = process.argv.slice(2);
  const mode = jsonModeOf(args);
  const json = args.includes('--json');
  const allowed = new Set(['--staged', '--json']);
  const unknown = args.filter((arg) => !allowed.has(arg));

  if (unknown.length > 0) {
    const message = `未知参数：${unknown.join(' ')}；仅支持 --staged、--json`;
    if (json) printJson({ mode, ok: false, error: message });
    else console.error(message);
    process.exitCode = 2;
    return;
  }

  try {
    assertNodeVersion();

    if ((process.env.DOCS_CHECK ?? '').trim().toLowerCase() === 'off') {
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

    process.exitCode = mode === 'staged' ? runStaged(root, json) : runFull(root, json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printJson({ mode, ok: false, error: message });
    else console.error(`文档检查无法执行：${message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main();
}
