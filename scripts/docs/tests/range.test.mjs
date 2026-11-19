/**
 * `--range` 逐提交文档同步检查与 pre-push 防绕过门禁。
 *
 * 覆盖：默认基线解析（origin/main → main → 2）、逐提交 require/warn、
 * 删除文档不算更新、删除代码仍算变更、`Docs-Check: off — <理由>` 例外、
 * 与 `--staged` 互斥、DOCS_CHECK=off 在 range 下失效、
 * pre-push 先门禁后转发旧 LFS hook。
 *
 * 实现前这些用例必须红灯：当前 CLI 不认识 --range（未知参数 → 2）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  REPO_ROOT,
  append,
  copyImplementation,
  git,
  makeRepo,
  outputOf,
  readDocMap,
  reportOf,
  runCli,
  runHook,
  stage,
  write,
  writeDocMap,
  writeFakeOldNode,
  writeRuntime,
} from './fixtures.mjs';

function fullJson(repo, env = {}) {
  return runCli(repo, ['--json'], { env });
}

function rangeJson(repo, spec, env = {}) {
  const args = spec === undefined ? ['--range', '--json'] : ['--range', spec, '--json'];
  return runCli(repo, args, { env });
}

function assertExit(result, expected, label = '') {
  assert.equal(
    result.status,
    expected,
    `${label}期望退出码 ${expected}，实际 ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function headSha(repo) {
  return git(repo, ['rev-parse', 'HEAD']);
}

function commit(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', message]);
  return headSha(repo);
}

function requireOneFailure(report, label) {
  assert.equal(report.mode, 'range', label);
  assert.equal(report.ok, false, label);
  assert.ok(Array.isArray(report.commits), `${label}：commits 必须是数组`);
  assert.ok(Array.isArray(report.failures), `${label}：failures 必须是数组`);
  assert.ok(Array.isArray(report.warnings), `${label}：warnings 必须是数组`);
  assert.equal(report.failures.length, 1, `${label}：${JSON.stringify(report, null, 2)}`);
  return report.failures[0];
}

test('range：require 域代码提交未更新文档 → 1', (t) => {
  const repo = makeRepo(t);
  const base = headSha(repo);
  append(repo, 'src/main/feature.ts', '\n// 追加说明。\n');
  const sha = commit(repo, 'fix(main): 调整主进程契约');

  const result = rangeJson(repo, `${base}..HEAD`);
  assertExit(result, 1, 'range require 缺文档');
  const report = reportOf(result);
  const failure = requireOneFailure(report, 'range require 缺文档');
  assert.equal(report.range, `${base}..HEAD`);
  assert.equal(report.commits.length, 1);
  assert.equal(report.commits[0].commit, sha);
  assert.equal(failure.commit, sha);
  assert.ok(failure.codeFiles.includes('src/main/feature.ts'));
  assert.ok(failure.rule.docs.includes('docs/architecture/desktop-ipc.md'));
});

test('range：同提交更新映射文档 → 0', (t) => {
  const repo = makeRepo(t);
  const base = headSha(repo);
  append(repo, 'src/main/feature.ts', '\n// 追加说明。\n');
  append(repo, 'docs/architecture/desktop-ipc.md', '\n补充契约说明，保证有同批更新。\n');
  commit(repo, 'fix(main): 调整主进程契约并同步文档');

  const result = rangeJson(repo, `${base}..HEAD`);
  assertExit(result, 0, 'range 同步文档');
  const report = reportOf(result);
  assert.equal(report.ok, true);
  assert.deepEqual(report.failures, []);
});

test('range：合法 Docs-Check trailer 放行；缺失/过短理由仍失败', (t) => {
  const repo = makeRepo(t);
  let base = headSha(repo);
  append(repo, 'src/main/feature.ts', '\n// 只改注释。\n');
  commit(
    repo,
    'fix(main): 只改注释\n\nDocs-Check: off — 本次仅调整注释，无契约变化',
  );
  assertExit(rangeJson(repo, `${base}..HEAD`), 0, '合法 trailer');

  base = headSha(repo);
  append(repo, 'src/main/feature.ts', '\n// 再改注释。\n');
  commit(repo, 'fix(main): 只改注释二\n\nDocs-Check: off — 太短');
  assertExit(rangeJson(repo, `${base}..HEAD`), 1, '过短理由');

  base = headSha(repo);
  append(repo, 'src/main/feature.ts', '\n// 又改注释。\n');
  commit(repo, 'fix(main): 只改注释三\n\nDocs-Check: off');
  assertExit(rangeJson(repo, `${base}..HEAD`), 1, '缺理由');

  base = headSha(repo);
  append(repo, 'src/main/feature.ts', '\n// 格式错误。\n');
  commit(repo, 'fix(main): 只改注释四\n\nDocs-Check:off — 前缀格式不合法但有足够长度');
  assertExit(rangeJson(repo, `${base}..HEAD`), 1, 'trailer 格式不符');
});

test('range：warn 域只提醒 → 0 且 warnings 非空', (t) => {
  const repo = makeRepo(t);
  const base = headSha(repo);
  append(repo, 'src/shared/util.ts', '\nexport const util3 = 3;\n');
  commit(repo, 'feat(shared): 增加工具函数');

  const result = rangeJson(repo, `${base}..HEAD`);
  assertExit(result, 0, 'range warn');
  const report = reportOf(result);
  assert.equal(report.ok, true);
  assert.equal(report.warnings.length, 1, JSON.stringify(report, null, 2));
});

test('range：删除文档不算更新；删除代码仍算变更', (t) => {
  const repo = makeRepo(t);
  let base = headSha(repo);
  append(repo, 'src/main/feature.ts', '\n// 改契约。\n');
  git(repo, ['rm', '-q', 'docs/architecture/desktop-ipc.md']);
  const deletedDocSha = commit(repo, 'fix(main): 改契约并删文档');

  let result = rangeJson(repo, `${base}..HEAD`);
  assertExit(result, 1, '删除文档不算更新');
  assert.equal(requireOneFailure(reportOf(result), '删除文档').commit, deletedDocSha);

  base = headSha(repo);
  git(repo, ['rm', '-q', 'src/main/other.ts']);
  const deletedCodeSha = commit(repo, 'refactor(main): 删除旧入口');
  result = rangeJson(repo, `${base}..HEAD`);
  assertExit(result, 1, '删除代码仍算变更');
  assert.equal(requireOneFailure(reportOf(result), '删除代码').commit, deletedCodeSha);
});

test('range：空范围 → 0；不存在 base → 2；与 --staged 同用 → 2', (t) => {
  const repo = makeRepo(t);

  const empty = rangeJson(repo, 'HEAD..HEAD');
  assertExit(empty, 0, '空 range');
  const report = reportOf(empty);
  assert.equal(report.ok, true);
  assert.deepEqual(report.commits, []);

  const missingBase = rangeJson(repo, 'no-such-ref..HEAD');
  assertExit(missingBase, 2, '缺 base');
  assert.equal(typeof reportOf(missingBase).error, 'string');

  const both = runCli(repo, ['--range', '--staged', '--json']);
  assertExit(both, 2, '--range 与 --staged 互斥');
  assert.equal(typeof reportOf(both).error, 'string');
});

test('range：DOCS_CHECK=off 环境变量不得跳过检查', (t) => {
  const repo = makeRepo(t);
  const base = headSha(repo);
  append(repo, 'src/main/feature.ts', '\n// 无文档更新。\n');
  commit(repo, 'fix(main): 未同步文档');

  const result = rangeJson(repo, `${base}..HEAD`, { DOCS_CHECK: 'off' });
  assertExit(result, 1, 'range 忽略 DOCS_CHECK=off');
  assert.equal(requireOneFailure(reportOf(result), 'range 忽略 env').commit, headSha(repo));

  // full 模式仍然尊重显式跳过
  assertExit(fullJson(repo, { DOCS_CHECK: 'off' }), 0, 'full 模式尊重 DOCS_CHECK=off');
});

test('range：默认基线 origin/main，回退 main，两者缺失 → 2', (t) => {
  const repo = makeRepo(t);
  const base = headSha(repo);
  git(repo, ['update-ref', 'refs/remotes/origin/main', base]);
  append(repo, 'src/main/feature.ts', '\n// 未同步文档。\n');
  commit(repo, 'fix(main): 未同步文档');
  assertExit(rangeJson(repo, undefined), 1, '默认 origin/main');

  const fallbackRepo = makeRepo(t);
  const fallbackBase = headSha(fallbackRepo);
  git(fallbackRepo, ['branch', '-m', 'main']);
  git(fallbackRepo, ['checkout', '-q', '-b', 'feature']);
  append(fallbackRepo, 'src/main/feature.ts', '\n// 未同步文档。\n');
  commit(fallbackRepo, 'fix(main): 未同步文档');
  const fallback = rangeJson(fallbackRepo, undefined);
  assertExit(fallback, 1, '回退 main');
  assert.equal(reportOf(fallback).range, `main..HEAD`);
  assert.ok(fallbackBase);

  const noBaseRepo = makeRepo(t);
  git(noBaseRepo, ['branch', '-m', 'trunk']);
  const noBase = rangeJson(noBaseRepo, undefined);
  assertExit(noBase, 2, '两类基线都缺失');
  assert.equal(typeof reportOf(noBase).error, 'string');
});

test('range：doc-map 损坏 → 2', (t) => {
  const repo = makeRepo(t);
  write(repo, 'docs/doc-map.json', '{ not json');

  const result = rangeJson(repo, 'HEAD..HEAD');
  assertExit(result, 2, 'doc-map 损坏');
  assert.match(reportOf(result).error, /doc-map|JSON/i);
});

/* ------------------------------ pre-push ------------------------------ */

function pushRepo(t, { runtime = true } = {}) {
  const repo = makeRepo(t);
  copyImplementation(repo);
  if (runtime) writeRuntime(repo);
  return repo;
}

function legacyPrePush(repo, body = '') {
  const legacyHook = path.join(repo, '.git', 'hooks', 'pre-push');
  const marker = path.join(repo, '.legacy-pre-push.log');
  fs.mkdirSync(path.dirname(legacyHook), { recursive: true });
  fs.writeFileSync(
    legacyHook,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" > ${path.basename(marker)}`,
      body || 'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.chmodSync(legacyHook, 0o755);
  return marker;
}

function commitCodeOnly(repo) {
  append(repo, 'src/main/feature.ts', '\n// 无文档更新。\n');
  return commit(repo, 'fix(main): 未同步文档（模拟 --no-verify 提交）');
}

test('pre-push：docs range 失败 → 1 且不转发旧 LFS hook', (t) => {
  const repo = pushRepo(t);
  const marker = legacyPrePush(repo);
  git(repo, ['update-ref', 'refs/remotes/origin/main', headSha(repo)]);
  commitCodeOnly(repo);

  const result = runHook(repo, 'pre-push', ['origin', 'https://example.test/repo.git']);
  assertExit(result, 1, 'pre-push 门禁失败');
  assert.equal(fs.existsSync(marker), false, 'docs 失败时不得执行旧 LFS pre-push');
});

test('pre-push：docs range 通过 → 转发旧 LFS hook 并透传参数', (t) => {
  const repo = pushRepo(t);
  const marker = legacyPrePush(repo);
  git(repo, ['update-ref', 'refs/remotes/origin/main', headSha(repo)]);
  append(repo, 'docs/guides/quality.md', '\n补充一段说明。\n');
  commit(repo, 'docs(guides): 补充说明');

  const result = runHook(repo, 'pre-push', ['origin', 'https://example.test/repo.git']);
  assertExit(result, 0, 'pre-push 门禁通过');
  assert.equal(fs.existsSync(marker), true, 'docs 通过后必须执行旧 LFS pre-push');
  assert.equal(
    fs.readFileSync(marker, 'utf8').trim(),
    'origin https://example.test/repo.git',
    '必须把原始参数转发给旧 hook',
  );

  fs.rmSync(path.join(repo, '.git', 'hooks', 'pre-push'), { force: true });
  fs.rmSync(marker, { force: true });
  assertExit(runHook(repo, 'pre-push', ['origin', 'url']), 0, '旧 hook 不存在时 no-op');
  assert.equal(fs.existsSync(marker), false);
});

test('pre-push：runtime 缺失或 < 22 → 2 且不转发旧 hook', (t) => {
  const missing = pushRepo(t, { runtime: false });
  const missingMarker = legacyPrePush(missing);
  git(missing, ['update-ref', 'refs/remotes/origin/main', headSha(missing)]);
  commitCodeOnly(missing);

  const missingResult = runHook(missing, 'pre-push', ['origin', 'url']);
  assertExit(missingResult, 2, 'runtime 缺失');
  assert.match(outputOf(missingResult), /runtime|install|hooks|运行时/i);
  assert.equal(fs.existsSync(missingMarker), false);

  const old = pushRepo(t);
  const oldMarker = legacyPrePush(old);
  const fakeRuntime = writeFakeOldNode(old);
  writeRuntime(old, fakeRuntime);
  git(old, ['update-ref', 'refs/remotes/origin/main', headSha(old)]);
  commitCodeOnly(old);

  const oldResult = runHook(old, 'pre-push', ['origin', 'url']);
  assertExit(oldResult, 2, 'runtime 版本过低');
  assert.match(outputOf(oldResult), /Node|22|版本/i);
  assert.equal(fs.existsSync(oldMarker), false);
});

/* --------------------------- 门禁接线 --------------------------- */

test('门禁接线：package.json 与 CI root job 都包含 check:docs:range', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(typeof pkg.scripts['check:docs:range'], 'string');
  assert.match(pkg.scripts['check:docs:range'], /check-docs\.mjs\b/);
  assert.match(pkg.scripts['check:docs:range'], /--range\b/);

  const ci = fs.readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  assert.match(ci, /npm run check:docs:range/, 'CI root job 必须运行 check:docs:range');
  assert.doesNotMatch(
    ci,
    /github\.event\.pull_request\.base\.sha/,
    'CI 不应再传 fork/PR base，range 由 doc-map rangeBaseline 控制',
  );
});

test('range：base 允许包含点号（release/1.2）', (t) => {
  const repo = makeRepo(t);
  const base = headSha(repo);
  git(repo, ['branch', 'release/1.2', base]);
  append(repo, 'src/main/feature.ts', '\n// 未同步文档。\n');
  commit(repo, 'fix(main): 未同步文档');

  assertExit(rangeJson(repo, 'release/1.2..HEAD'), 1, '带点 base');
});

test('range：任何提交改动冻结证据 → 1（即使 doc-map 未命中）', (t) => {
  const repo = makeRepo(t);
  let base = headSha(repo);

  append(repo, 'docs/reviews/README.md', '\n被篡改。\n');
  const rewriteSha = commit(repo, 'chore: 篡改冻结证据（模拟 --no-verify）');
  let result = rangeJson(repo, `${base}..HEAD`);
  assertExit(result, 1, '冻结证据被修改');
  let frozen = reportOf(result).failures.find(
    (failure) => failure.code === 'frozen-evidence-modified',
  );
  assert.ok(frozen, JSON.stringify(reportOf(result), null, 2));
  assert.equal(frozen.commit, rewriteSha);
  assert.deepEqual(frozen.paths, ['docs/reviews/README.md']);

  base = headSha(repo);
  write(repo, 'docs/superpowers/old-evidence.md', '# 旧证据\n');
  const resurrectSha = commit(repo, 'chore: 复活 docs/superpowers');
  result = rangeJson(repo, `${base}..HEAD`);
  assertExit(result, 1, 'docs/superpowers 复活');
  frozen = reportOf(result).failures.find(
    (failure) => failure.code === 'frozen-evidence-modified',
  );
  assert.ok(frozen, JSON.stringify(reportOf(result), null, 2));
  assert.equal(frozen.commit, resurrectSha);
  assert.deepEqual(frozen.paths, ['docs/superpowers/old-evidence.md']);

  base = headSha(repo);
  git(repo, ['rm', '-q', 'docs/reviews/c12-gate.md']);
  const deleteSha = commit(repo, 'chore: 删除冻结证据');
  result = rangeJson(repo, `${base}..HEAD`);
  assertExit(result, 1, '删除冻结证据');
  frozen = reportOf(result).failures.find(
    (failure) => failure.code === 'frozen-evidence-modified',
  );
  assert.ok(frozen, JSON.stringify(reportOf(result), null, 2));
  assert.equal(frozen.commit, deleteSha);
});

test('range：merge commit 用 first-parent diff，不能成为盲区', (t) => {
  const repo = makeRepo(t);
  const base = headSha(repo);

  // 旁支：只改文档，作为 merge 的第二父。
  git(repo, ['checkout', '-q', '-b', 'side']);
  append(repo, 'docs/guides/quality.md', '\n旁支说明。\n');
  const sideCommit = commit(repo, 'docs(guides): 旁支说明');

  // 代码树：相对第一父（base）只有 src/main 改动，没有文档更新。
  git(repo, ['checkout', '-q', '-b', 'code', base]);
  append(repo, 'src/main/feature.ts', '\n// 冲突解决时夹带的代码改动。\n');
  const codeCommit = commit(repo, 'fix(main): 冲突解决夹带代码');
  const codeTree = git(repo, ['rev-parse', `${codeCommit}^{tree}`]);
  const currentBranch = git(repo, ['symbolic-ref', '--short', 'HEAD']);

  const mergeSha = git(repo, [
    'commit-tree',
    codeTree,
    '-p',
    base,
    '-p',
    sideCommit,
    '-m',
    'merge: 合入旁支',
  ]);
  git(repo, ['update-ref', `refs/heads/${currentBranch}`, mergeSha]);

  const result = rangeJson(repo, `${base}..HEAD`);
  assertExit(result, 1, 'merge commit first-parent diff');
  const report = reportOf(result);
  assert.ok(
    report.failures.some((failure) => failure.commit === mergeSha),
    `merge commit 必须被检查：${JSON.stringify(report, null, 2)}`,
  );
});

test('pre-push：冻结证据改动 → 1 且不转发旧 hook', (t) => {
  const repo = pushRepo(t);
  const marker = legacyPrePush(repo);
  git(repo, ['update-ref', 'refs/remotes/origin/main', headSha(repo)]);
  append(repo, 'docs/reviews/README.md', '\n被篡改。\n');
  commit(repo, 'chore: 篡改冻结证据（模拟 --no-verify）');

  const result = runHook(repo, 'pre-push', ['origin', 'url']);
  assertExit(result, 1, 'pre-push 冻结证据');
  assert.equal(fs.existsSync(marker), false);
});

test('range：doc-map.rangeBaseline 是一次性初始化边界（不反噬历史）', (t) => {
  const repo = makeRepo(t);
  const beforeMigration = headSha(repo);

  // 基线之前的初始化迁移：触碰 docs/reviews，不应被默认 range 反噬。
  append(repo, 'docs/reviews/README.md', '\n初始化迁移说明。\n');
  const migrationSha = commit(repo, 'refactor: 初始化迁移冻结证据');
  const baseline = headSha(repo);

  // 基线之后的 code-only 提交：必须失败。
  append(repo, 'src/main/feature.ts', '\n// 未同步文档。\n');
  const codeSha = commit(repo, 'fix(main): 未同步文档');

  const docMap = readDocMap(repo);
  docMap.rangeBaseline = baseline;
  writeDocMap(repo, docMap);

  const result = rangeJson(repo);
  assertExit(result, 1, 'rangeBaseline 之后的 code-only 提交');
  const report = reportOf(result);
  assert.equal(report.range, `${baseline}..HEAD`);
  assert.deepEqual(report.commits.map((entry) => entry.commit), [codeSha]);
  assert.ok(
    !report.failures.some((failure) => failure.commit === migrationSha),
    `基线之前的冻结提交不得被报告：${JSON.stringify(report, null, 2)}`,
  );
  assert.ok(report.failures.some((failure) => failure.commit === codeSha));

  // 显式 --range 仍优先于 rangeBaseline。
  const explicit = rangeJson(repo, `${beforeMigration}..HEAD`);
  assertExit(explicit, 1, '显式 range 覆盖基线');
  const explicitReport = reportOf(explicit);
  assert.ok(
    explicitReport.failures.some(
      (failure) => failure.code === 'frozen-evidence-modified' && failure.commit === migrationSha,
    ),
    `显式 range 必须检查基线之前的冻结改动：${JSON.stringify(explicitReport, null, 2)}`,
  );
});

test('range：rangeBaseline 非 commit 或格式非法 → 2', (t) => {
  const repo = makeRepo(t);

  let docMap = readDocMap(repo);
  docMap.rangeBaseline = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  writeDocMap(repo, docMap);
  assertExit(rangeJson(repo), 2, '不存在的 rangeBaseline');

  docMap = readDocMap(repo);
  docMap.rangeBaseline = 'not-a-sha';
  writeDocMap(repo, docMap);
  assertExit(rangeJson(repo), 2, '非法格式 rangeBaseline');

  docMap = readDocMap(repo);
  docMap.rangeBaseline = '';
  writeDocMap(repo, docMap);
  assertExit(rangeJson(repo), 2, '空 rangeBaseline');
});
