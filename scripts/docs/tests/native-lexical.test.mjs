/**
 * native / 前端宿主语言的词法扫描契约。
 *
 * 覆盖：C 系注释（行注释与块注释，含 Kotlin/Swift 三引号原始字符串）、
 * XML/.plist/.html 的 XML 注释、CSS 的块注释；
 * 字符串、属性值与文本节点中的 docs 路径不得误报；
 * 真实仓库全量检查必须跳过 scripts/docs/tests/fixtures。
 *
 * 这些用例在 native 扫描实现前必须红灯（注释引用缺失文档却返回 0）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  TESTS_DIR,
  assertIssue,
  issuesOf,
  makeRepo,
  reportOf,
  runCli,
  stage,
} from './fixtures.mjs';

function assertExit(result, expected, label = '') {
  assert.equal(
    result.status,
    expected,
    `${label}期望退出码 ${expected}，实际 ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

const NATIVE_FIXTURES = path.join(TESTS_DIR, 'fixtures', 'native');

const COMMENT_FIXTURES = [
  'comments.kt',
  'comments.kts',
  'comments.ets',
  'comments.m',
  'comments.swift',
  'comments.xml',
  'comments.plist',
  'comments.css',
  'comments.html',
];

const STRING_FIXTURES = [
  'strings.kt',
  'strings.ets',
  'strings.m',
  'strings.swift',
  'attrs.xml',
  'attrs.plist',
  'attrs.css',
  'attrs.html',
];

function installFixtures(repo, group, names, targetDir = 'native') {
  const destination = path.join(repo, ...targetDir.split('/'));
  fs.mkdirSync(destination, { recursive: true });
  for (const name of names) {
    fs.copyFileSync(
      path.join(NATIVE_FIXTURES, group, name),
      path.join(destination, name),
    );
  }
}

function fullJson(repo) {
  return runCli(repo, ['--json']);
}

function assertExitAndReport(result, expected, label) {
  assertExit(result, expected, label);
  return reportOf(result);
}

test('native 注释引用缺失文档 → missing-code-doc（字符串与原始字符串不误报）', (t) => {
  const repo = makeRepo(t);
  installFixtures(repo, 'comments', COMMENT_FIXTURES);
  stage(repo, 'native');

  const result = fullJson(repo);
  const report = assertExitAndReport(result, 1, 'native 注释缺文档');

  const expectations = [
    ['native/comments.kt', 3, 'docs/architecture/ghost-kotlin.md'],
    ['native/comments.kts', 1, 'docs/guides/ghost-kts.md'],
    ['native/comments.ets', 1, 'docs/architecture/ghost-ets.md'],
    ['native/comments.m', 3, 'docs/architecture/ghost-objc.md'],
    ['native/comments.swift', 3, 'docs/architecture/ghost-swift.md'],
    ['native/comments.xml', 2, 'docs/guides/ghost-xml.md'],
    ['native/comments.plist', 3, 'docs/guides/ghost-plist.md'],
    ['native/comments.css', 1, 'docs/guides/ghost-css.md'],
    ['native/comments.html', 2, 'docs/guides/ghost-html.md'],
  ];

  for (const [filePath, line, docPath] of expectations) {
    assertIssue(
      report,
      (issue) =>
        issue.code === 'missing-code-doc'
        && issue.path === filePath
        && issue.line === line
        && String(issue.message).includes(docPath),
      `${filePath}:${line} 应报 ${docPath}`,
    );
  }

  const nonCommentPaths = [
    'ghost-kotlin-raw.md',
    'ghost-swift-raw.md',
    'ghost-xml-attr.md',
    'ghost-xml-text.md',
    'ghost-plist-string.md',
    'ghost-html-text.md',
  ];
  for (const ghost of nonCommentPaths) {
    assert.ok(
      !issuesOf(report).some((issue) => String(issue.message).includes(ghost)),
      `字符串/属性/文本节点中的 ${ghost} 不应命中\n${JSON.stringify(issuesOf(report), null, 2)}`,
    );
  }
});

test('native 字符串、属性值与模板字符串中的 docs 路径 → 0', (t) => {
  const repo = makeRepo(t);
  installFixtures(repo, 'strings', STRING_FIXTURES);
  stage(repo, 'native');

  const result = fullJson(repo);
  const report = assertExitAndReport(result, 0, 'native 字符串不误报');
  assert.deepEqual(issuesOf(report), []);
});

test('真实仓库全量检查跳过 scripts/docs/tests/fixtures', (t) => {
  const repo = makeRepo(t);
  installFixtures(repo, 'comments', COMMENT_FIXTURES, 'scripts/docs/tests/fixtures/native');
  installFixtures(repo, 'strings', STRING_FIXTURES, 'scripts/docs/tests/fixtures/native');
  stage(repo, 'scripts/docs/tests/fixtures');

  const result = fullJson(repo);
  const report = assertExitAndReport(result, 0, 'fixtures 目录不得误报');
  assert.deepEqual(issuesOf(report), []);
});
