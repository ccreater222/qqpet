/**
 * docs hooks 与安装脚本的端到端契约测试。
 *
 * 每个用例把实现文件复制进临时仓库，再直接执行 hook，避免污染当前仓库的
 * core.hooksPath，也避免依赖真实提交。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  append,
  copyImplementation,
  git,
  gitTry,
  makeRepo,
  outputOf,
  runHook,
  runInstallHooks,
  stage,
  write,
  writeFakeOldNode,
  writeRuntime,
} from './fixtures.mjs';

function preparedRepo(t, { runtime = true } = {}) {
  const repo = makeRepo(t);
  copyImplementation(repo);
  if (runtime) writeRuntime(repo);
  return repo;
}

function configGet(repo, key, extraArgs = []) {
  const result = gitTry(repo, ['config', ...extraArgs, '--get', key]);
  return result.status === 0 ? result.stdout.trim() : '';
}

function stageDocsOnly(repo, content = '\n补充说明。\n') {
  append(repo, 'docs/guides/quality.md', content);
  stage(repo, 'docs/guides/quality.md');
}

function writeMessageFile(repo, content) {
  const messagePath = path.join(repo, '.git', 'COMMIT_MSG_TEST');
  fs.writeFileSync(messagePath, content, 'utf8');
  return messagePath;
}

test('hooks:install：默认 hooksPath → 设为 .githooks，并记录 Node 绝对路径', (t) => {
  const repo = preparedRepo(t, { runtime: false });

  const result = runInstallHooks(repo);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(configGet(repo, 'core.hooksPath'), '.githooks');

  const runtimePath = path.join(repo, '.githooks', 'runtime');
  assert.equal(fs.existsSync(runtimePath), true, '安装后必须写入 .githooks/runtime');
  assert.equal(fs.readFileSync(runtimePath, 'utf8').trim(), process.execPath);

  const ignored = git(repo, ['check-ignore', '--', '.githooks/runtime']);
  assert.equal(ignored, '.githooks/runtime', '.githooks/runtime 必须被 gitignore');
});

test('hooks:install：已是 .githooks 时幂等 → 0', (t) => {
  const repo = preparedRepo(t, { runtime: false });

  const first = runInstallHooks(repo);
  assert.equal(first.status, 0, `第一次安装失败：${outputOf(first)}`);
  const second = runInstallHooks(repo);
  assert.equal(second.status, 0, `第二次安装失败：${outputOf(second)}`);
  assert.equal(configGet(repo, 'core.hooksPath'), '.githooks');
});

test('hooks:install：已有其它 hooksPath → 报错且不覆盖', (t) => {
  const repo = preparedRepo(t, { runtime: false });
  git(repo, ['config', 'core.hooksPath', '.husky']);

  const result = runInstallHooks(repo);
  assert.notEqual(result.status, 0, '已有自定义 hooksPath 时必须失败');
  assert.equal(configGet(repo, 'core.hooksPath'), '.husky');
  assert.match(outputOf(result), /未覆盖|已有|existing|hooksPath/i);
});

test('hooks:install --prepare：已有其它 hooksPath → 只警告且 0', (t) => {
  const repo = preparedRepo(t, { runtime: false });
  git(repo, ['config', 'core.hooksPath', '.husky']);

  const result = runInstallHooks(repo, ['--prepare']);
  assert.equal(result.status, 0, `--prepare 不应失败：${outputOf(result)}`);
  assert.equal(configGet(repo, 'core.hooksPath'), '.husky');
  assert.match(outputOf(result), /未覆盖|已有|warning|警告|hooksPath/i);
});

test('hooks:install：已有自定义 pre-commit 时拒绝接管', (t) => {
  const repo = preparedRepo(t, { runtime: false });
  write(repo, '.githooks/pre-commit', '#!/bin/sh\necho custom-hook\n');

  const result = runInstallHooks(repo);
  assert.notEqual(result.status, 0, '已有自定义 pre-commit 时必须失败');
  assert.equal(configGet(repo, 'core.hooksPath'), '');
});

test('hooks:install --worktree：启用 worktreeConfig 并写入 worktree 级 hooksPath', (t) => {
  const repo = preparedRepo(t, { runtime: false });

  const result = runInstallHooks(repo, ['--worktree']);
  assert.equal(result.status, 0, `--worktree 安装失败：${outputOf(result)}`);
  assert.equal(configGet(repo, 'extensions.worktreeConfig'), 'true');
  assert.equal(configGet(repo, 'core.hooksPath', ['--worktree']), '.githooks');
});

test('pre-commit：只改文档且全量/ staged 均通过 → 0', (t) => {
  const repo = preparedRepo(t);
  stageDocsOnly(repo);

  const result = runHook(repo, 'pre-commit');
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

test('pre-commit：staged 变更命中 require 但缺文档 → 1', (t) => {
  const repo = preparedRepo(t);
  append(repo, 'src/main/feature.ts', '\n// 追加：无行为变化。\n');
  stage(repo, 'src/main/feature.ts');

  const result = runHook(repo, 'pre-commit');
  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(outputOf(result), /desktop-ipc|文档|主进程契约/i);
});

test('pre-commit：warn 规则命中但缺文档 → 0', (t) => {
  const repo = preparedRepo(t);
  append(repo, 'src/shared/util.ts', '\nexport const util2 = 2;\n');
  stage(repo, 'src/shared/util.ts');

  const result = runHook(repo, 'pre-commit');
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

test('pre-commit：先拒绝 docs/reviews 变更，再检查运行时 → 1', (t) => {
  const repo = preparedRepo(t, { runtime: false });
  append(repo, 'docs/reviews/c12-gate.md', '\n被篡改。\n');
  stage(repo, 'docs/reviews/c12-gate.md');

  const result = runHook(repo, 'pre-commit');
  assert.equal(
    result.status,
    1,
    `docs/reviews 必须最先失败（缺 runtime 也应先报冻结）：\n${outputOf(result)}`,
  );
  assert.match(outputOf(result), /frozen|冻结|reviews/i);
});

test('pre-commit：运行时文件缺失 → 2', (t) => {
  const repo = preparedRepo(t);
  fs.rmSync(path.join(repo, '.githooks', 'runtime'), { force: true });
  stageDocsOnly(repo);

  const result = runHook(repo, 'pre-commit');
  assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(outputOf(result), /runtime|install|hooks|运行时/i);
});

test('pre-commit：运行时 Node 版本 < 22 → 2', (t) => {
  const repo = preparedRepo(t);
  const fakeRuntime = writeFakeOldNode(repo);
  writeRuntime(repo, fakeRuntime);
  stageDocsOnly(repo);

  const result = runHook(repo, 'pre-commit');
  assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(outputOf(result), /Node|22|版本/i);
});

test('commit-msg：DOCS_CHECK=off 且理由合法 → 0', (t) => {
  const repo = preparedRepo(t);
  const messagePath = writeMessageFile(
    repo,
    'chore: 只补测试\n\nDocs-Check: off — 本次仅补充测试用例\n',
  );

  const result = runHook(repo, 'commit-msg', [messagePath], { env: { DOCS_CHECK: 'off' } });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

test('commit-msg：DOCS_CHECK=off 但缺 Docs-Check 行 → 1', (t) => {
  const repo = preparedRepo(t);
  const messagePath = writeMessageFile(repo, 'chore: 只补测试\n');

  const result = runHook(repo, 'commit-msg', [messagePath], { env: { DOCS_CHECK: 'off' } });
  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(outputOf(result), /Docs-Check/i);
});

test('commit-msg：DOCS_CHECK=off 但理由少于 8 个字符 → 1', (t) => {
  const repo = preparedRepo(t);
  const messagePath = writeMessageFile(repo, 'chore: 只补测试\n\nDocs-Check: off — 太短\n');

  const result = runHook(repo, 'commit-msg', [messagePath], { env: { DOCS_CHECK: 'off' } });
  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(outputOf(result), /Docs-Check|理由|8/i);
});

test('commit-msg：未设置 DOCS_CHECK=off 时不要求理由 → 0', (t) => {
  const repo = preparedRepo(t);
  const messagePath = writeMessageFile(repo, 'chore: 普通提交\n');

  const result = runHook(repo, 'commit-msg', [messagePath]);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

test('hooks:install：旧默认 hooks 目录已有自定义 pre-commit 时拒绝切换（--prepare 只警告）', (t) => {
  const repo = preparedRepo(t, { runtime: false });
  const legacyHook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(legacyHook, '#!/bin/sh\necho legacy-hook\n', 'utf8');
  fs.chmodSync(legacyHook, 0o755);

  const result = runInstallHooks(repo);
  assert.notEqual(result.status, 0, '旧 hooks 目录已有自定义 pre-commit 时必须失败');
  assert.equal(configGet(repo, 'core.hooksPath'), '');
  assert.match(outputOf(result), /旧|legacy|hooks|未覆盖|已有/i);

  const prepared = runInstallHooks(repo, ['--prepare']);
  assert.equal(prepared.status, 0, `--prepare 应只警告：${outputOf(prepared)}`);
  assert.equal(configGet(repo, 'core.hooksPath'), '');
  assert.match(outputOf(prepared), /警告|旧|legacy|hooks|未覆盖/i);
});

test('hooks:install：旧默认 hooks 目录已有自定义 commit-msg 时拒绝切换', (t) => {
  const repo = preparedRepo(t, { runtime: false });
  const legacyHook = path.join(repo, '.git', 'hooks', 'commit-msg');
  fs.writeFileSync(legacyHook, '#!/bin/sh\necho legacy-commit-msg\n', 'utf8');
  fs.chmodSync(legacyHook, 0o755);

  const result = runInstallHooks(repo);
  assert.notEqual(result.status, 0, '旧 hooks 目录已有自定义 commit-msg 时必须失败');
  assert.equal(configGet(repo, 'core.hooksPath'), '');
  assert.match(outputOf(result), /旧|legacy|hooks|未覆盖|已有/i);
});

test('pre-commit：docs/reviews 重命名（删除侧）同样被冻结检查拒绝 → 1', (t) => {
  const repo = preparedRepo(t);
  git(repo, ['mv', 'docs/reviews/c12-gate.md', 'docs/architecture/c12-gate.md']);
  write(
    repo,
    'docs/architecture/c12-gate.md',
    `# C12 归档说明

> 结论：这是用于验证重命名删除侧冻结检查的合法文档。

## 1. 范围

正文一。

正文二。
`,
  );
  append(repo, 'docs/README.md', '\n- [C12 归档说明](architecture/c12-gate.md)\n');
  stage(repo, 'docs/architecture/c12-gate.md', 'docs/README.md');

  const result = runHook(repo, 'pre-commit');
  assert.equal(
    result.status,
    1,
    `重命名删除侧必须被 docs/reviews 冻结检查拒绝：\n${outputOf(result)}`,
  );
  assert.match(outputOf(result), /frozen|冻结|reviews/i);
});

test('LFS wrapper：旧 hook 存在时转发参数，不存在时 no-op → 0', (t) => {
  const repo = preparedRepo(t);
  for (const hookName of ['post-checkout', 'post-commit', 'post-merge', 'pre-push']) {
    const legacyHook = path.join(repo, '.git', 'hooks', hookName);
    const marker = path.join(repo, `.lfs-${hookName}.log`);
    fs.writeFileSync(
      legacyHook,
      `#!/bin/sh\nprintf '%s\\n' "$*" > .lfs-${hookName}.log\n`,
      'utf8',
    );
    fs.chmodSync(legacyHook, 0o755);

    const forwarded = runHook(repo, hookName, ['arg-one', 'arg-two']);
    assert.equal(forwarded.status, 0, `${hookName} 转发失败：${outputOf(forwarded)}`);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'arg-one arg-two');

    fs.rmSync(legacyHook, { force: true });
    fs.rmSync(marker, { force: true });
    const noop = runHook(repo, hookName, ['arg-one']);
    assert.equal(noop.status, 0, `${hookName} 无 legacy 时应 no-op：${outputOf(noop)}`);
    assert.equal(fs.existsSync(marker), false, `${hookName} 无 legacy 时不应执行任何旧 hook`);
  }
});
