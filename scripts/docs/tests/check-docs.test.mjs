/**
 * check-docs CLI 端到端契约测试。
 *
 * 覆盖：完整树通过、链接（inline/reference/HTML/大小写/编码/外链/锚点/fence）、
 * 结构与引用、doc-map、staged 同步、工具错误与四种 JSON 形状。
 * 每个用例都在基线合法树上做单向变更，失败原因必须可定位。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  append,
  assertIssue,
  commitAll,
  git,
  issuesOf,
  makeRepo,
  outputOf,
  readDocMap,
  reportOf,
  runCli,
  stage,
  write,
  writeDocMap,
  writeFakeNodeVersionModule,
} from './fixtures.mjs';

const VALID_DOC = `# 测试文档

> 结论：这是一份满足 living docs 结构的测试文档。

## 1. 范围

正文一。

正文二。
`;

function fullJson(repo, options = {}) {
  return runCli(repo, ['--json'], options);
}

function stagedJson(repo, options = {}) {
  return runCli(repo, ['--staged', '--json'], options);
}

function addIndexLink(repo, relativeTarget, label = '新文档') {
  append(repo, 'docs/README.md', `\n- [${label}](${relativeTarget})\n`);
}

function assertExit(result, expected, label = '') {
  assert.equal(
    result.status,
    expected,
    `${label}期望退出码 ${expected}，实际 ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

test('完整临时 docs 树 + doc-map + 代码注释引用 → 0', (t) => {
  const repo = makeRepo(t);
  const result = fullJson(repo);

  assertExit(result, 0, '全量检查');
  const report = reportOf(result);
  assert.equal(report.mode, 'full');
  assert.equal(report.ok, true);
  assert.deepEqual(issuesOf(report), []);
});

test('inline 链接存在 → 0；reference-style 链接存在 → 0', (t) => {
  const repo = makeRepo(t);
  append(
    repo,
    'docs/architecture/desktop-ipc.md',
    '\n参考 [质量门禁][quality]。\n\n[quality]: ../guides/quality.md\n',
  );

  const result = fullJson(repo);
  assertExit(result, 0, 'reference-style 链接');
});

test('reference-style 链接目标缺失 → 1 broken-link', (t) => {
  const repo = makeRepo(t);
  append(
    repo,
    'docs/architecture/desktop-ipc.md',
    '\n参考 [不存在][ghost]。\n\n[ghost]: ../guides/ghost.md\n',
  );

  const result = fullJson(repo);
  assertExit(result, 1, 'reference-style 死链');
  assertIssue(
    reportOf(result),
    (issue) =>
      issue.code === 'broken-link' && issue.path === 'docs/architecture/desktop-ipc.md',
    'reference-style 死链',
  );
});

test('HTML href/src 存在 → 0；目标缺失 → 1 broken-link', (t) => {
  const passRepo = makeRepo(t);
  append(
    passRepo,
    'docs/architecture/desktop-ipc.md',
    '\n<a href="../guides/quality.md">质量门禁</a>\n<img src="../guides/quality.md" alt="占位">\n',
  );
  assertExit(fullJson(passRepo), 0, 'HTML 链接存在');

  const failRepo = makeRepo(t);
  append(
    failRepo,
    'docs/architecture/desktop-ipc.md',
    '\n<a href="../guides/ghost.md">不存在</a>\n<img src="../guides/ghost.md" alt="不存在">\n',
  );
  const result = fullJson(failRepo);
  assertExit(result, 1, 'HTML 死链');
  assertIssue(reportOf(result), (issue) => issue.code === 'broken-link', 'HTML 死链');
});

test('链接大小写与磁盘不一致 → 1（macOS 上也不能放过）', (t) => {
  const repo = makeRepo(t);
  append(repo, 'docs/architecture/desktop-ipc.md', '\n[大小写](../Guides/quality.md)\n');

  const result = fullJson(repo);
  assertExit(result, 1, '大小写不一致');
  assertIssue(
    reportOf(result),
    (issue) =>
      issue.code === 'broken-link' && issue.path === 'docs/architecture/desktop-ipc.md',
    '大小写不一致',
  );
});

test('URL 编码路径按解码后校验，编码正确 → 0', (t) => {
  const repo = makeRepo(t);
  write(repo, 'docs/guides/space doc.md', VALID_DOC);
  write(repo, 'docs/guides/中文.md', VALID_DOC);
  append(repo, 'docs/README.md', '\n- [空格文档](guides/space%20doc.md)\n');
  append(repo, 'docs/README.md', '- [中文文档](guides/%E4%B8%AD%E6%96%87.md)\n');

  assertExit(fullJson(repo), 0, 'URL 编码链接');
});

test('外链、纯锚点、mailto 忽略 → 0', (t) => {
  const repo = makeRepo(t);
  append(
    repo,
    'docs/architecture/desktop-ipc.md',
    [
      '',
      '[外链](https://example.com/docs/guides/ghost.md)',
      '[锚点](#1-通道契约)',
      '[邮件](mailto:docs@example.test)',
      '',
    ].join('\n'),
  );

  assertExit(fullJson(repo), 0, '外链与锚点');
});

test('fence 与行内 code 内的链接不检查 → 0', (t) => {
  const repo = makeRepo(t);
  const content = [
    '',
    '```md',
    '[坏链](ghost.md)',
    '<a href="ghost.md">坏链</a>',
    '[ghost]: ghost.md',
    '```',
    '',
    '行内代码 `[坏链](ghost.md)` 与 `<a href="ghost.md">` 不检查。',
    '',
  ].join('\n');
  append(repo, 'docs/architecture/desktop-ipc.md', content);

  assertExit(fullJson(repo), 0, 'fence/inline code');
});

test('非法目录中的 markdown → 1 invalid-location', (t) => {
  const repo = makeRepo(t);
  write(repo, 'docs/misc/note.md', VALID_DOC);

  const result = fullJson(repo);
  assertExit(result, 1, '非法目录');
  assertIssue(
    reportOf(result),
    (issue) => issue.code === 'invalid-location' && issue.path === 'docs/misc/note.md',
    '非法目录',
  );
});

test('living 文档未进 docs/README 索引 → 1 unindexed-doc', (t) => {
  const repo = makeRepo(t);
  write(repo, 'docs/architecture/unindexed.md', VALID_DOC);

  const result = fullJson(repo);
  assertExit(result, 1, '未索引文档');
  assertIssue(
    reportOf(result),
    (issue) => issue.path === 'docs/architecture/unindexed.md' && issue.code === 'unindexed-doc',
    '未索引文档',
  );
});

test('runbook 未登记到 docs/runbooks/README → 1', (t) => {
  const repo = makeRepo(t);
  write(repo, 'docs/runbooks/secret-recovery.md', VALID_DOC);
  addIndexLink(repo, 'runbooks/secret-recovery.md', '密钥恢复');

  const result = fullJson(repo);
  assertExit(result, 1, '未索引 runbook');
  assertIssue(
    reportOf(result),
    (issue) =>
      issue.path === 'docs/runbooks/secret-recovery.md' &&
      (issue.code === 'unindexed-runbook' || /runbook|索引|登记/i.test(issue.message ?? '')),
    '未索引 runbook',
  );
});

test('禁用文件名 → 1 forbidden-filename', (t) => {
  const repo = makeRepo(t);
  write(repo, 'docs/architecture/feature-final.md', VALID_DOC);
  addIndexLink(repo, 'architecture/feature-final.md');

  const result = fullJson(repo);
  assertExit(result, 1, '禁用文件名');
  assertIssue(
    reportOf(result),
    (issue) =>
      issue.code === 'forbidden-filename' &&
      issue.path === 'docs/architecture/feature-final.md',
    '禁用文件名',
  );
});

test('空文档（少于 5 个非空行）→ 1 empty-doc', (t) => {
  const repo = makeRepo(t);
  write(repo, 'docs/architecture/empty.md', '# 空文档\n\n> 结论：待补。\n');
  addIndexLink(repo, 'architecture/empty.md');

  const result = fullJson(repo);
  assertExit(result, 1, '空文档');
  assertIssue(
    reportOf(result),
    (issue) => issue.code === 'empty-doc' && issue.path === 'docs/architecture/empty.md',
    '空文档',
  );
});

test('超过行数上限 → 1 doc-too-long', (t) => {
  const repo = makeRepo(t);
  const lines = ['# 长文档', '', '> 结论：测试行数上限。', ''];
  for (let index = 0; index < 620; index += 1) lines.push(`第 ${index} 行。`);
  write(repo, 'docs/architecture/long.md', `${lines.join('\n')}\n`);
  addIndexLink(repo, 'architecture/long.md');

  const result = fullJson(repo);
  assertExit(result, 1, '超行数');
  assertIssue(
    reportOf(result),
    (issue) => issue.code === 'doc-too-long' && issue.path === 'docs/architecture/long.md',
    '超行数',
  );
});

test('一份文档两个 H1 → 1 duplicate-h1', (t) => {
  const repo = makeRepo(t);
  write(
    repo,
    'docs/architecture/two-h1.md',
    `# 双标题

> 结论：测试双 H1。

## 1. 范围

正文。

# 第二个 H1

正文二。
`,
  );
  addIndexLink(repo, 'architecture/two-h1.md');

  const result = fullJson(repo);
  assertExit(result, 1, '双 H1');
  assertIssue(
    reportOf(result),
    (issue) => issue.code === 'duplicate-h1' && issue.path === 'docs/architecture/two-h1.md',
    '双 H1',
  );
});

test('缺 > 结论： → 1', (t) => {
  const repo = makeRepo(t);
  write(
    repo,
    'docs/architecture/no-conclusion.md',
    `# 无结论

背景介绍。

## 1. 范围

- 背景一
- 背景二
- 边界

结束。
`,
  );
  addIndexLink(repo, 'architecture/no-conclusion.md');

  const result = fullJson(repo);
  assertExit(result, 1, '缺结论');
  assertIssue(
    reportOf(result),
    (issue) =>
      issue.path === 'docs/architecture/no-conclusion.md' &&
      (issue.code === 'missing-conclusion' || /结论/.test(issue.message ?? '')),
    '缺结论',
  );
});

test('代码注释引用不存在的文档 → 1 missing-code-doc', (t) => {
  const repo = makeRepo(t);
  append(repo, 'src/shared/util.ts', '\n// 参考 docs/guides/ghost.md。\n');

  const result = fullJson(repo);
  assertExit(result, 1, '代码注释缺文档');
  assertIssue(
    reportOf(result),
    (issue) => issue.code === 'missing-code-doc' && issue.path === 'src/shared/util.ts',
    '代码注释缺文档',
  );
});

test('字符串、URL 中的 docs 路径不误报 → 0', (t) => {
  const repo = makeRepo(t);
  write(
    repo,
    'src/shared/noise.ts',
    `// 上游说明见 https://example.com/docs/guides/ghost.md。
export const single = 'docs/guides/ghost.md';
export const double = "docs/architecture/ghost.md";
export const template = \`docs/runbooks/ghost.md\`;
`,
  );

  assertExit(fullJson(repo), 0, '字符串内 docs 路径');
});

test('代码注释引用不存在的 §N → 1 missing-doc-section', (t) => {
  const repo = makeRepo(t);
  append(repo, 'src/main/feature.ts', '\n// 契约见 docs/architecture/desktop-ipc.md §9。\n');

  const result = fullJson(repo);
  assertExit(result, 1, '代码注释缺章节');
  assertIssue(
    reportOf(result),
    (issue) =>
      issue.code === 'missing-doc-section' &&
      issue.path === 'src/main/feature.ts' &&
      /9/.test(issue.message ?? ''),
    '代码注释缺章节',
  );
});

test('living 文档正文引用不存在的 §N → 1 missing-doc-section', (t) => {
  const repo = makeRepo(t);
  append(repo, 'docs/guides/quality.md', '\n另见 docs/architecture/desktop-ipc.md §9。\n');

  const result = fullJson(repo);
  assertExit(result, 1, '文档正文缺章节');
  assertIssue(
    reportOf(result),
    (issue) =>
      issue.code === 'missing-doc-section' && issue.path === 'docs/guides/quality.md',
    '文档正文缺章节',
  );
});

test('living 文档正文引用不存在的 docs 路径 → 1 missing-doc-reference', (t) => {
  const repo = makeRepo(t);
  append(repo, 'docs/guides/quality.md', '\n详见 docs/architecture/ghost.md。\n');

  const result = fullJson(repo);
  assertExit(result, 1, '文档正文缺文档');
  assertIssue(
    reportOf(result),
    (issue) =>
      issue.code === 'missing-doc-reference' && issue.path === 'docs/guides/quality.md',
    '文档正文缺文档',
  );
});

test('裸文件名重名时跳过 §N 解析 → 0', (t) => {
  const repo = makeRepo(t);
  write(repo, 'docs/architecture/dup.md', VALID_DOC);
  write(repo, 'docs/guides/dup.md', VALID_DOC);
  addIndexLink(repo, 'architecture/dup.md');
  append(repo, 'docs/README.md', '- [重复名](guides/dup.md)\n');
  append(repo, 'src/shared/util.ts', '\n// 说明见 dup.md §9。\n');

  assertExit(fullJson(repo), 0, '裸文件名重名');
});

test('裸文件名唯一时校验 §N → 1', (t) => {
  const repo = makeRepo(t);
  append(repo, 'src/shared/util.ts', '\n// 说明见 quality.md §9。\n');

  const result = fullJson(repo);
  assertExit(result, 1, '唯一裸文件名缺章节');
  assertIssue(
    reportOf(result),
    (issue) => issue.code === 'missing-doc-section' && issue.path === 'src/shared/util.ts',
    '唯一裸文件名缺章节',
  );
});

test('doc-map 缺失 → 2 error JSON', (t) => {
  const repo = makeRepo(t);
  fs.rmSync(path.join(repo, 'docs', 'doc-map.json'));

  const result = fullJson(repo);
  assertExit(result, 2, 'doc-map 缺失');
  const report = reportOf(result);
  assert.equal(report.mode, 'full');
  assert.equal(report.ok, false);
  assert.equal(typeof report.error, 'string');
  assert.ok(report.error.length > 0);
});

test('doc-map 损坏 → 2 error JSON', (t) => {
  const repo = makeRepo(t);
  write(repo, 'docs/doc-map.json', '{ "rules": [\n');

  const result = fullJson(repo);
  assertExit(result, 2, 'doc-map 损坏');
  const report = reportOf(result);
  assert.equal(report.mode, 'full');
  assert.equal(report.ok, false);
  assert.equal(typeof report.error, 'string');
});

test('doc-map 空规则表 → 1 empty-doc-map', (t) => {
  const repo = makeRepo(t);
  writeDocMap(repo, { version: 1, rules: [] });

  const result = fullJson(repo);
  assertExit(result, 1, '空规则表');
  assertIssue(reportOf(result), (issue) => issue.code === 'empty-doc-map', '空规则表');
});

test('doc-map include 或 docs 为空 → 1 empty-doc-map-rule', (t) => {
  const emptyIncludeRepo = makeRepo(t);
  const map = readDocMap(emptyIncludeRepo);
  writeDocMap(emptyIncludeRepo, {
    version: 1,
    rules: [{ ...map.rules[0], include: [] }],
  });
  const includeResult = fullJson(emptyIncludeRepo);
  assertExit(includeResult, 1, '空 include');
  assertIssue(
    reportOf(includeResult),
    (issue) => issue.code === 'empty-doc-map-rule',
    '空 include',
  );

  const emptyDocsRepo = makeRepo(t);
  const map2 = readDocMap(emptyDocsRepo);
  writeDocMap(emptyDocsRepo, {
    version: 1,
    rules: [{ ...map2.rules[0], docs: [] }],
  });
  const docsResult = fullJson(emptyDocsRepo);
  assertExit(docsResult, 1, '空 docs');
  assertIssue(reportOf(docsResult), (issue) => issue.code === 'empty-doc-map-rule', '空 docs');
});

test('doc-map 缺 reason → 1', (t) => {
  const repo = makeRepo(t);
  const map = readDocMap(repo);
  const { reason: _reason, ...ruleWithoutReason } = map.rules[0];
  writeDocMap(repo, { version: 1, rules: [{ ...ruleWithoutReason, reason: '' }] });

  const result = fullJson(repo);
  assertExit(result, 1, '缺 reason');
  assertIssue(
    reportOf(result),
    (issue) =>
      issue.path === 'docs/doc-map.json' &&
      /reason|原因|理由/.test(`${issue.code} ${issue.message ?? ''}`),
    '缺 reason',
  );
});

test('doc-map 目标不存在 → 1 missing-doc-map-target', (t) => {
  const repo = makeRepo(t);
  const map = readDocMap(repo);
  writeDocMap(repo, {
    version: 1,
    rules: [{ ...map.rules[0], docs: ['docs/architecture/ghost.md'] }],
  });

  const result = fullJson(repo);
  assertExit(result, 1, '目标不存在');
  assertIssue(
    reportOf(result),
    (issue) => issue.code === 'missing-doc-map-target',
    '目标不存在',
  );
});

test('doc-map 目标不是 living 文档 → 1 invalid-doc-map-target', (t) => {
  const repo = makeRepo(t);
  const map = readDocMap(repo);
  writeDocMap(repo, {
    version: 1,
    rules: [{ ...map.rules[0], docs: ['docs/reviews/c12-gate.md'] }],
  });

  const result = fullJson(repo);
  assertExit(result, 1, '非 living 目标');
  assertIssue(
    reportOf(result),
    (issue) => issue.code === 'invalid-doc-map-target',
    '非 living 目标',
  );
});

test('doc-map 死规则（include 不匹配任何文件）→ 1 dead-doc-map-rule', (t) => {
  const repo = makeRepo(t);
  const map = readDocMap(repo);
  writeDocMap(repo, {
    version: 1,
    rules: [{ ...map.rules[0], include: ['src/legacy/**'] }],
  });

  const result = fullJson(repo);
  assertExit(result, 1, '死规则');
  assertIssue(reportOf(result), (issue) => issue.code === 'dead-doc-map-rule', '死规则');
});

test('staged：require 命中但未更新文档 → 1，JSON 含 failures/impacts', (t) => {
  const repo = makeRepo(t);
  append(repo, 'src/main/feature.ts', '\n// 追加：无行为变化。\n');
  stage(repo, 'src/main/feature.ts');

  const result = stagedJson(repo);
  assertExit(result, 1, 'staged require 缺文档');
  const report = reportOf(result);
  assert.equal(report.mode, 'staged');
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 1);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.failures[0].rule.reason, '主进程契约变更');
  assert.deepEqual(report.failures[0].codeFiles, ['src/main/feature.ts']);
  assert.deepEqual(report.failures[0].missingDocs, ['docs/architecture/desktop-ipc.md']);
  assert.equal(report.impacts.length, 1);
});

test('staged：warn 命中但未更新文档 → 0，只提醒', (t) => {
  const repo = makeRepo(t);
  append(repo, 'src/shared/util.ts', '\nexport const util2 = 2;\n');
  stage(repo, 'src/shared/util.ts');

  const result = stagedJson(repo);
  assertExit(result, 0, 'staged warn');
  const report = reportOf(result);
  assert.equal(report.mode, 'staged');
  assert.equal(report.ok, true);
  assert.deepEqual(report.failures, []);
  assert.equal(report.warnings.length, 1);
  assert.equal(report.warnings[0].rule.mode, 'warn');
});

test('staged：代码与映射文档同 commit → 0', (t) => {
  const repo = makeRepo(t);
  append(repo, 'src/main/feature.ts', '\n// 追加：契约说明更新。\n');
  append(repo, 'docs/architecture/desktop-ipc.md', '\n补充说明。\n');
  stage(repo, 'src/main/feature.ts', 'docs/architecture/desktop-ipc.md');

  const result = stagedJson(repo);
  assertExit(result, 0, 'staged 更新文档');
  const report = reportOf(result);
  assert.equal(report.ok, true);
  assert.deepEqual(report.failures, []);
  assert.equal(report.impacts.length, 1);
  assert.deepEqual(report.impacts[0].stagedDocs, ['docs/architecture/desktop-ipc.md']);
});

test('staged：删除映射文档不能算更新 → 1', (t) => {
  const repo = makeRepo(t);
  const docPath = path.join(repo, 'docs', 'architecture', 'desktop-ipc.md');
  const originalDoc = fs.readFileSync(docPath, 'utf8');

  // 让工作区保留的已删除文件被忽略，隔离 index/worktree 分歧，
  // 这样失败只能来自“删除文档被误当作已更新”。
  append(repo, '.gitignore', 'docs/architecture/desktop-ipc.md\n');
  append(repo, 'src/main/feature.ts', '\n// 追加：代码变更。\n');
  git(repo, ['rm', '-q', 'docs/architecture/desktop-ipc.md']);
  write(repo, 'docs/architecture/desktop-ipc.md', originalDoc);
  git(repo, ['check-ignore', '--', 'docs/architecture/desktop-ipc.md']);
  stage(repo, 'src/main/feature.ts');

  const result = stagedJson(repo);
  assertExit(result, 1, '删除文档');
  const report = reportOf(result);
  assert.equal(report.mode, 'staged');
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 1, JSON.stringify(report, null, 2));
  assert.deepEqual(report.failures[0].stagedDocs, []);
  assert.deepEqual(report.failures[0].codeFiles, ['src/main/feature.ts']);
});

test('staged：index 与 worktree 分歧 → 1 staged-worktree-divergence', (t) => {
  const repo = makeRepo(t);
  append(repo, 'src/main/feature.ts', '\n// 已暂存。\n');
  stage(repo, 'src/main/feature.ts');
  append(repo, 'src/main/feature.ts', '// 未暂存的后续改动。\n');

  const result = stagedJson(repo);
  assertExit(result, 1, 'index/worktree 分歧');
  assertIssue(
    reportOf(result),
    (issue) =>
      issue.code === 'staged-worktree-divergence' && issue.path === 'src/main/feature.ts',
    'index/worktree 分歧',
  );
});

test('staged：git rm --cached 移出被忽略文件放行 → 0', (t) => {
  const repo = makeRepo(t);
  write(repo, 'tmp/handoff.md', '# 本地交接材料\n');
  git(repo, ['add', '-f', '--', 'tmp/handoff.md']);
  commitAll(repo, 'test: track ignored handoff');
  git(repo, ['rm', '-q', '--cached', '--', 'tmp/handoff.md']);

  assert.equal(
    fs.existsSync(path.join(repo, 'tmp/handoff.md')),
    true,
    'git rm --cached 不应删除工作区文件',
  );
  const ignored = git(repo, ['check-ignore', '--', 'tmp/handoff.md']);
  assert.equal(ignored, 'tmp/handoff.md');

  const result = stagedJson(repo);
  assertExit(result, 0, 'git rm --cached 忽略文件');
  const report = reportOf(result);
  assert.equal(report.ok, true);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.impacts, []);
});

test('staged：rename 不折叠，按 D+A 处理 → 1', (t) => {
  const repo = makeRepo(t);
  fs.mkdirSync(path.join(repo, 'src', 'other'), { recursive: true });
  git(repo, ['mv', 'src/main/feature.ts', 'src/other/feature.ts']);

  const result = stagedJson(repo);
  assertExit(result, 1, 'rename D+A');
  const report = reportOf(result);
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 1);
  assert.ok(
    report.failures[0].codeFiles.includes('src/main/feature.ts'),
    `rename 的删除侧必须纳入影响：${JSON.stringify(report.failures[0], null, 2)}`,
  );
});

test('staged：只改文档 / 未命中映射 / 无 staged → 0，impacts 为空', (t) => {
  const docsRepo = makeRepo(t);
  append(docsRepo, 'docs/architecture/desktop-ipc.md', '\n补充说明。\n');
  stage(docsRepo, 'docs/architecture/desktop-ipc.md');
  const docsResult = stagedJson(docsRepo);
  assertExit(docsResult, 0, '只改文档');
  assert.deepEqual(reportOf(docsResult).impacts, []);

  const unmappedRepo = makeRepo(t);
  write(unmappedRepo, 'src/tools/note.mjs', 'export const note = 1;\n');
  stage(unmappedRepo, 'src/tools/note.mjs');
  const unmappedResult = stagedJson(unmappedRepo);
  assertExit(unmappedResult, 0, '未命中映射');
  assert.deepEqual(reportOf(unmappedResult).impacts, []);

  const cleanRepo = makeRepo(t);
  const cleanResult = stagedJson(cleanRepo);
  assertExit(cleanResult, 0, '无 staged');
  assert.deepEqual(reportOf(cleanResult).impacts, []);
});

test('非 git 目录 → 2 error JSON', (t) => {
  const repo = makeRepo(t, { git: false });
  const result = fullJson(repo);

  assertExit(result, 2, '非 git 目录');
  const report = reportOf(result);
  assert.equal(report.mode, 'full');
  assert.equal(report.ok, false);
  assert.equal(typeof report.error, 'string');
});

test('缺 docs/ 目录 → 2 error JSON', (t) => {
  const repo = makeRepo(t);
  fs.rmSync(path.join(repo, 'docs'), { recursive: true, force: true });
  commitAll(repo, 'test: remove docs');

  const result = fullJson(repo);
  assertExit(result, 2, '缺 docs/');
  const report = reportOf(result);
  assert.equal(report.ok, false);
  assert.equal(typeof report.error, 'string');
});

test('未知参数 → 2', (t) => {
  const repo = makeRepo(t);
  const result = runCli(repo, ['--json', '--bogus']);

  assertExit(result, 2, '未知参数');
  assert.match(outputOf(result), /未知|unknown|参数/i);
});

test('Node 版本不足 → 2（通过 --import 伪造 process.version）', (t) => {
  const repo = makeRepo(t);
  const fakeModule = writeFakeNodeVersionModule();
  t.after(() => fs.rmSync(fakeModule, { force: true }));

  const result = runCli(repo, ['--json'], { nodeArgs: ['--import', fakeModule] });
  assertExit(result, 2, 'Node 版本不足');
  const report = reportOf(result);
  assert.equal(report.ok, false);
  assert.match(`${report.error ?? ''}`, /node|Node|版本|22/);
});

test('DOCS_CHECK=off → 0，full/staged 都输出 skipped JSON 形状', (t) => {
  const repo = makeRepo(t);

  const fullResult = runCli(repo, ['--json'], { env: { DOCS_CHECK: 'off' } });
  assertExit(fullResult, 0, 'full skipped');
  const fullReport = reportOf(fullResult);
  assert.equal(fullReport.mode, 'full');
  assert.equal(fullReport.ok, true);
  assert.equal(fullReport.skipped, true);
  assert.equal(typeof fullReport.reason, 'string');
  assert.ok(fullReport.reason.length > 0);

  const stagedResult = runCli(repo, ['--staged', '--json'], { env: { DOCS_CHECK: 'off' } });
  assertExit(stagedResult, 0, 'staged skipped');
  const stagedReport = reportOf(stagedResult);
  assert.equal(stagedReport.mode, 'staged');
  assert.equal(stagedReport.ok, true);
  assert.equal(stagedReport.skipped, true);
  assert.equal(typeof stagedReport.reason, 'string');
});
