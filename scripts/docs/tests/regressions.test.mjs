/**
 * 独立验收 B1–B5 的失败关闭回归。
 *
 * 这些用例在修复前必须红灯，且只做新增：不改既有测试断言。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CLI_PATH,
  INSTALL_HOOKS_PATH,
  append,
  copyImplementation,
  git,
  issuesOf,
  makeRepo,
  outputOf,
  reportOf,
  runCli,
  write,
} from './fixtures.mjs';

function cleanEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.DOCS_CHECK;
  delete env.npm_lifecycle_event;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function runRelativeHook(repo, hookName, args = []) {
  return spawnSync(`.githooks/${hookName}`, args, {
    cwd: repo,
    encoding: 'utf8',
    env: cleanEnv(),
    timeout: 10_000,
  });
}

function runNodeEntry(entry, cwd, args = []) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(),
    timeout: 20_000,
  });
}

function makeNonGitDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-docs-nongit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeSymlinkEntry(t, target, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-docs-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, name);
  fs.symlinkSync(target, link);
  return link;
}

test('B1 LFS wrapper：core.hooksPath=.githooks 时仍转发旧 .git/hooks 并透传退出码', (t) => {
  const repo = makeRepo(t);
  copyImplementation(repo);
  git(repo, ['config', 'core.hooksPath', '.githooks']);

  for (const hookName of ['post-checkout', 'post-commit', 'post-merge', 'pre-push']) {
    const legacyHook = path.join(repo, '.git', 'hooks', hookName);
    const markerName = `.legacy-${hookName}.log`;
    const marker = path.join(repo, markerName);
    fs.writeFileSync(
      legacyHook,
      `#!/bin/sh\nprintf '%s\\n' "$*" > ${markerName}\nexit 7\n`,
      'utf8',
    );
    fs.chmodSync(legacyHook, 0o755);

    const forwarded = runRelativeHook(repo, hookName, ['arg-one', 'arg-two']);
    assert.equal(
      forwarded.status,
      7,
      `${hookName} 未转发旧 hook（期望透传 7）：${outputOf(forwarded)}`,
    );
    assert.equal(
      fs.readFileSync(marker, 'utf8').trim(),
      'arg-one arg-two',
      `${hookName} 未把参数转发给旧 hook`,
    );

    fs.rmSync(marker, { force: true });
    fs.chmodSync(legacyHook, 0o644);
    const nonExecutable = runRelativeHook(repo, hookName, ['arg-one']);
    assert.equal(
      nonExecutable.status,
      0,
      `${hookName} 旧 hook 不可执行时应 no-op：${outputOf(nonExecutable)}`,
    );
    assert.equal(fs.existsSync(marker), false);

    fs.rmSync(legacyHook, { force: true });
    fs.rmSync(marker, { force: true });
    const noop = runRelativeHook(repo, hookName, ['arg-one']);
    assert.equal(noop.status, 0, `${hookName} 旧 hook 不存在时应 no-op：${outputOf(noop)}`);
    assert.equal(fs.existsSync(marker), false);
  }
});

test('B2 入口 guard：通过 /tmp symlink 调用 check-docs，非 git 仍应 2 且有输出', (t) => {
  const entry = makeSymlinkEntry(t, CLI_PATH, 'check-docs.mjs');
  const cwd = makeNonGitDir(t);

  const result = runNodeEntry(entry, cwd, ['--json']);
  assert.equal(
    result.status,
    2,
    `symlink 入口应执行并返回 2，实际 ${result.status}：${outputOf(result)}`,
  );
  assert.ok(outputOf(result).trim().length > 0, 'symlink 入口不能静默无输出');
  const report = reportOf(result);
  assert.equal(report.ok, false);
  assert.equal(typeof report.error, 'string');
});

test('B2 入口 guard：通过 /tmp symlink 调用 install-hooks 不能静默 0', (t) => {
  const entry = makeSymlinkEntry(t, INSTALL_HOOKS_PATH, 'install-hooks.mjs');
  const cwd = makeNonGitDir(t);

  const result = runNodeEntry(entry, cwd);
  assert.notEqual(result.status, 0, `symlink 入口不能静默 0：${outputOf(result)}`);
  assert.ok(outputOf(result).trim().length > 0, 'symlink 入口不能静默无输出');
});

test('B3 零 H1 的 living 文档 → 1 missing-h1', (t) => {
  const repo = makeRepo(t);
  write(
    repo,
    'docs/standards/no-h1.md',
    `> 结论：这是一份故意缺少 H1 的回归文档。

## 1. 范围

正文一。

正文二。

正文三。
`,
  );
  append(repo, 'docs/README.md', '\n- [零 H1 反例](standards/no-h1.md)\n');

  const result = runCli(repo, ['--json']);
  assert.equal(result.status, 1, `零 H1 必须失败：${outputOf(result)}`);
  assert.ok(
    issuesOf(reportOf(result)).some(
      (issue) => issue.code === 'missing-h1' && issue.path === 'docs/standards/no-h1.md',
    ),
    `缺少 missing-h1：${result.stdout}`,
  );
});

test('B4 docs/reports 与 docs/slides 不再豁免 → 1 invalid-location', (t) => {
  const repo = makeRepo(t);
  write(repo, 'docs/reports/foo.md', '# 报告\n\n正文。\n');
  write(repo, 'docs/slides/foo.md', '# 幻灯片\n\n正文。\n');

  const result = runCli(repo, ['--json']);
  assert.equal(result.status, 1, `非法目录必须失败：${outputOf(result)}`);
  const issues = issuesOf(reportOf(result));
  for (const docPath of ['docs/reports/foo.md', 'docs/slides/foo.md']) {
    assert.ok(
      issues.some((issue) => issue.code === 'invalid-location' && issue.path === docPath),
      `${docPath} 必须报 invalid-location：${JSON.stringify(issues, null, 2)}`,
    );
  }
});

test('B5 不可读 tracked 源码 → 2（不是静默 0）', (t) => {
  const repo = makeRepo(t);
  const sourcePath = path.join(repo, 'src', 'main', 'feature.ts');
  const originalMode = fs.statSync(sourcePath).mode & 0o777;
  t.after(() => {
    try {
      fs.chmodSync(sourcePath, originalMode);
    } catch {
      /* 临时目录可能已清理 */
    }
  });
  try {
    fs.chmodSync(sourcePath, 0o000);
    const result = runCli(repo, ['--json']);
    assert.equal(result.status, 2, `不可读源码必须报工具错误 2：${outputOf(result)}`);
    const report = reportOf(result);
    assert.equal(report.ok, false);
    assert.equal(typeof report.error, 'string');
  } finally {
    fs.chmodSync(sourcePath, originalMode);
  }
});

test('B5 不可读 docs 子目录 → 2（不是 broken-link 1）', (t) => {
  const repo = makeRepo(t);
  const docsGuides = path.join(repo, 'docs', 'guides');
  const originalMode = fs.statSync(docsGuides).mode & 0o777;
  t.after(() => {
    try {
      fs.chmodSync(docsGuides, originalMode);
    } catch {
      /* 临时目录可能已清理 */
    }
  });
  try {
    fs.chmodSync(docsGuides, 0o000);
    const result = runCli(repo, ['--json']);
    assert.equal(result.status, 2, `不可读 docs 子目录必须报工具错误 2：${outputOf(result)}`);
    const report = reportOf(result);
    assert.equal(report.ok, false);
    assert.equal(typeof report.error, 'string');
  } finally {
    fs.chmodSync(docsGuides, originalMode);
  }
});
