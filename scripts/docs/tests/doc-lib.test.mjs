/**
 * 纯函数库契约测试。
 *
 * 这里锁定的是 CLI 与 hooks 共同依赖的最小公开面：
 * 路径归一化/大小写校验/glob、doc-map 解析与校验、单文档内容规则、
 * staged 影响计算、章节号解析。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  checkDocContent,
  classifyDocPath,
  collectDocSections,
  computeStagedImpact,
  existsWithExactCase,
  matchesGlob,
  matchesRule,
  normalizeRepoPath,
  parseDocMap,
  validateDocMap,
} from '../doc-lib.mjs';
import { tempDir, writeFiles } from './fixtures.mjs';

const VALID_DOC = `# 标题

> 结论：这是一份用于契约测试的合法文档。

## 1. 范围

正文一。

正文二。
`;

function issueCodes(issues) {
  return issues.map((issue) => issue.code);
}

function rule(overrides = {}) {
  return {
    include: ['src/main/**'],
    exclude: [],
    docs: ['docs/architecture/x.md'],
    mode: 'require',
    reason: '测试规则',
    ...overrides,
  };
}

test('normalizeRepoPath：统一分隔符、去除 ./ 与冗余段', () => {
  assert.equal(normalizeRepoPath('./docs\\architecture\\x.md'), 'docs/architecture/x.md');
  assert.equal(normalizeRepoPath('docs/./a/../b.md'), 'docs/b.md');
  assert.equal(normalizeRepoPath('docs//a.md'), 'docs/a.md');
});

test('existsWithExactCase：逐级区分大小写', (t) => {
  const root = tempDir(t);
  writeFiles(root, { 'Docs/README.md': '# x\n' });

  assert.equal(existsWithExactCase(root, 'Docs/README.md'), true);
  assert.equal(existsWithExactCase(root, 'docs/README.md'), false);
  assert.equal(existsWithExactCase(root, 'Docs/readme.md'), false);
  assert.equal(existsWithExactCase(root, 'Docs'), true);
  assert.equal(existsWithExactCase(root, '.'), true);
});

test('matchesGlob：* 不跨目录，** 跨目录；exclude 生效', () => {
  assert.equal(matchesGlob('src/main/a.ts', 'src/**'), true);
  assert.equal(matchesGlob('src/a.ts', 'src/*.ts'), true);
  assert.equal(matchesGlob('src/nested/a.ts', 'src/*.ts'), false);
  assert.equal(matchesGlob('docs/a/b.md', 'docs/**/*.md'), true);
  assert.equal(matchesGlob('src/main/a.test.ts', 'src/**/*.test.ts'), true);
  assert.equal(matchesGlob('src/main/a.ts', '**/*.test.ts'), false);

  const withExclude = rule({ exclude: ['src/main/legacy/**'] });
  assert.equal(matchesRule('src/main/a.ts', withExclude), true);
  assert.equal(matchesRule('src/main/legacy/a.ts', withExclude), false);
  assert.equal(matchesRule('src/shared/a.ts', withExclude), false);
});

test('computeStagedImpact：require 缺文档失败、更新文档通过', () => {
  const requireRule = rule();
  const missing = computeStagedImpact(
    [{ status: 'M', path: 'src/main/a.ts' }],
    [requireRule],
  );

  assert.equal(missing.ok, false);
  assert.equal(missing.failures.length, 1);
  assert.equal(missing.warnings.length, 0);
  assert.deepEqual(missing.failures[0].codeFiles, ['src/main/a.ts']);
  assert.deepEqual(missing.failures[0].missingDocs, ['docs/architecture/x.md']);
  assert.deepEqual(missing.failures[0].stagedDocs, []);

  const updated = computeStagedImpact(
    [
      { status: 'M', path: 'src/main/a.ts' },
      { status: 'M', path: 'docs/architecture/x.md' },
    ],
    [requireRule],
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.failures.length, 0);
  assert.deepEqual(updated.impacts[0].stagedDocs, ['docs/architecture/x.md']);
});

test('computeStagedImpact：warn 只提醒不阻断，且未命中映射时无影响', () => {
  const warnRule = rule({ mode: 'warn' });
  const warned = computeStagedImpact([{ status: 'M', path: 'src/main/a.ts' }], [warnRule]);
  assert.equal(warned.ok, true);
  assert.equal(warned.failures.length, 0);
  assert.equal(warned.warnings.length, 1);
  assert.equal(warned.warnings[0].rule.mode, 'warn');

  const unrelated = computeStagedImpact([{ status: 'A', path: 'scripts/other.mjs' }], [warnRule]);
  assert.equal(unrelated.ok, true);
  assert.deepEqual(unrelated.impacts, []);
});

test('computeStagedImpact：删除文档不算更新，删除代码仍算契约变更', () => {
  const deletedDoc = computeStagedImpact(
    [
      { status: 'M', path: 'src/main/a.ts' },
      { status: 'D', path: 'docs/architecture/x.md' },
    ],
    [rule()],
  );
  assert.equal(deletedDoc.ok, false, '删除目标文档不能被当作“已更新文档”');
  assert.equal(deletedDoc.failures.length, 1);
  assert.deepEqual(deletedDoc.failures[0].stagedDocs, []);

  const deletedCode = computeStagedImpact(
    [{ status: 'D', path: 'src/main/a.ts' }],
    [rule()],
  );
  assert.equal(deletedCode.ok, false, '删除被映射的代码同样需要文档说明');
  assert.deepEqual(deletedCode.failures[0].codeFiles, ['src/main/a.ts']);
});

test('checkDocContent：合法文档无 issue', () => {
  assert.deepEqual(checkDocContent('docs/architecture/x.md', VALID_DOC), []);
});

test('checkDocContent：空文档、双 H1、超行数、禁用文件名', () => {
  const empty = checkDocContent('docs/architecture/empty.md', '# 空\n\n> 结论：待补。\n');
  assert.ok(issueCodes(empty).includes('empty-doc'), JSON.stringify(empty));

  const doubleH1 = checkDocContent('docs/architecture/two.md', `${VALID_DOC}\n# 第二个标题\n`);
  assert.ok(issueCodes(doubleH1).includes('duplicate-h1'), JSON.stringify(doubleH1));

  const fenceH1 = checkDocContent(
    'docs/architecture/fence.md',
    `${VALID_DOC}\n\`\`\`md\n# 代码块里的井号不是标题\n\`\`\`\n`,
  );
  assert.ok(!issueCodes(fenceH1).includes('duplicate-h1'), JSON.stringify(fenceH1));

  const long = ['# 长文档', '', '> 结论：测试行数上限。', ''];
  for (let index = 0; index < 650; index += 1) long.push(`第 ${index} 行。`);
  const tooLong = checkDocContent('docs/architecture/long.md', `${long.join('\n')}\n`);
  assert.ok(issueCodes(tooLong).includes('doc-too-long'), JSON.stringify(tooLong));

  const underGuideLimit = checkDocContent('docs/guides/long.md', `${long.join('\n')}\n`);
  assert.ok(
    !issueCodes(underGuideLimit).includes('doc-too-long'),
    'guides 上限是 1000 行，650 行不应超限',
  );

  const forbidden = checkDocContent('docs/architecture/feature-final.md', VALID_DOC);
  assert.ok(issueCodes(forbidden).includes('forbidden-filename'), JSON.stringify(forbidden));
});

test('checkDocContent：H1 后第一段必须是 > 结论：', () => {
  const missingConclusion = `# 标题

## 1. 范围

- 只有背景
- 没有结论
- 也没有边界

结束。
`;
  const issues = checkDocContent('docs/architecture/no-conclusion.md', missingConclusion);
  assert.ok(
    issues.some(
      (issue) => issue.code === 'missing-conclusion' || /结论/.test(issue.message ?? ''),
    ),
    JSON.stringify(issues),
  );

  const conclusionLater = `# 标题

背景介绍。

> 结论：结论不在第一段。

## 1. 范围

正文。
`;
  const laterIssues = checkDocContent('docs/architecture/later.md', conclusionLater);
  assert.ok(
    laterIssues.some(
      (issue) => issue.code === 'missing-conclusion' || /结论/.test(issue.message ?? ''),
    ),
    '结论必须紧跟 H1 的第一段，不能埋在正文后面',
  );
});

test('classifyDocPath：living / frozen / invalid', () => {
  assert.equal(classifyDocPath('docs/README.md'), 'living');
  assert.equal(classifyDocPath('docs/reviews/README.md'), 'living');
  assert.equal(classifyDocPath('docs/standards/documentation.md'), 'living');
  assert.equal(classifyDocPath('docs/specs/x.md'), 'living');
  assert.equal(classifyDocPath('docs/architecture/x.md'), 'living');
  assert.equal(classifyDocPath('docs/guides/x.md'), 'living');
  assert.equal(classifyDocPath('docs/runbooks/x.md'), 'living');
  assert.equal(classifyDocPath('docs/reviews/c12-gate.md'), 'frozen');
  assert.equal(classifyDocPath('docs/misc/x.md'), 'invalid');
  assert.equal(classifyDocPath('docs/superpowers/acceptance/x.md'), 'invalid');
});

test('parseDocMap：非法 JSON 与缺 rules 必须显式报错', () => {
  assert.throws(() => parseDocMap('{'), /JSON|Unexpected|解析|格式/i);
  assert.throws(() => parseDocMap('{"version":1}'), /rules|规则/i);
  assert.throws(
    () =>
      parseDocMap(
        JSON.stringify({
          rules: [{ include: [], docs: [], mode: 'blocking', reason: 'x' }],
        }),
      ),
    /mode|规则|格式/i,
  );

  const parsed = parseDocMap(JSON.stringify({ version: 1, rules: [rule()] }));
  assert.equal(parsed.rules.length, 1);
  assert.deepEqual(parsed.rules[0].exclude, []);
});

test('validateDocMap：空表、空字段、缺 reason、缺目标、非 living、死规则', (t) => {
  const root = tempDir(t);
  writeFiles(root, {
    'docs/architecture/x.md': VALID_DOC,
    'docs/reviews/frozen.md': '# 冻结\n',
  });
  const exists = (repoPath) => fs.existsSync(path.join(root, ...repoPath.split('/')));
  const knownFiles = ['src/main/a.ts'];

  const emptyMap = validateDocMap({ version: 1, rules: [] }, exists, knownFiles);
  assert.ok(issueCodes(emptyMap).includes('empty-doc-map'), JSON.stringify(emptyMap));

  const emptyInclude = validateDocMap(
    { version: 1, rules: [rule({ include: [] })] },
    exists,
    knownFiles,
  );
  assert.ok(
    issueCodes(emptyInclude).includes('empty-doc-map-rule'),
    JSON.stringify(emptyInclude),
  );

  const emptyDocs = validateDocMap(
    { version: 1, rules: [rule({ docs: [] })] },
    exists,
    knownFiles,
  );
  assert.ok(issueCodes(emptyDocs).includes('empty-doc-map-rule'), JSON.stringify(emptyDocs));

  const noReason = validateDocMap(
    { version: 1, rules: [rule({ reason: '' })] },
    exists,
    knownFiles,
  );
  assert.ok(
    noReason.some(
      (issue) => /reason|原因|理由/.test(`${issue.code} ${issue.message ?? ''}`),
    ),
    `缺 reason 必须报错：${JSON.stringify(noReason)}`,
  );

  const missingTarget = validateDocMap(
    { version: 1, rules: [rule({ docs: ['docs/architecture/ghost.md'] })] },
    exists,
    knownFiles,
  );
  assert.ok(
    issueCodes(missingTarget).includes('missing-doc-map-target'),
    JSON.stringify(missingTarget),
  );

  const frozenTarget = validateDocMap(
    { version: 1, rules: [rule({ docs: ['docs/reviews/frozen.md'] })] },
    exists,
    knownFiles,
  );
  assert.ok(
    issueCodes(frozenTarget).includes('invalid-doc-map-target'),
    JSON.stringify(frozenTarget),
  );

  const deadRule = validateDocMap(
    { version: 1, rules: [rule({ include: ['src/legacy/**'] })] },
    exists,
    knownFiles,
  );
  assert.ok(issueCodes(deadRule).includes('dead-doc-map-rule'), JSON.stringify(deadRule));

  const valid = validateDocMap({ version: 1, rules: [rule()] }, exists, knownFiles);
  assert.deepEqual(valid, []);
});

test('collectDocSections：识别标题章节号并补齐祖先章节', () => {
  const sections = collectDocSections(`# 标题

> 结论：测试。

## 1. 范围

### 1.2 细节

## 2 第二节

## 3. 附录
`);
  assert.equal(sections.has('1'), true);
  assert.equal(sections.has('1.2'), true);
  assert.equal(sections.has('2'), true);
  assert.equal(sections.has('3'), true);
  assert.equal(sections.has('9'), false);
});
