/**
 * docs 检查器契约测试的公共夹具。
 *
 * 约定：
 * - 每个用例使用 mkdtemp 创建独立临时仓库，互不污染；
 * - 临时仓库基线必须是一棵通过全量检查的合法 docs 树；
 * - CLI 一律用 process.execPath spawn，避免依赖 PATH 里的 node；
 * - 本文件不导入 ../doc-lib.mjs，保证 CLI 级红灯来自缺失的 check-docs.mjs。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TESTS_DIR, '..', '..', '..');
export const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'docs', 'check-docs.mjs');
export const INSTALL_HOOKS_PATH = path.join(REPO_ROOT, 'scripts', 'docs', 'install-hooks.mjs');
export const HOOKS_DIR = path.join(REPO_ROOT, '.githooks');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};

function cleanEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  if (!Object.hasOwn(overrides, 'DOCS_CHECK')) delete env.DOCS_CHECK;
  if (!Object.hasOwn(overrides, 'npm_lifecycle_event')) delete env.npm_lifecycle_event;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

export function tempDir(t, prefix = 'qqpet-docs-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
  }
}

export function write(root, relativePath, content) {
  writeFiles(root, { [relativePath]: content });
}

export function append(root, relativePath, content) {
  const absolutePath = path.join(root, ...relativePath.split('/'));
  fs.appendFileSync(absolutePath, content, 'utf8');
}

export function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} 失败（cwd=${cwd}，status=${result.status}）\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

export function gitTry(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

export function initRepo(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Docs Contract Test']);
  git(dir, ['config', 'user.email', 'docs-contract@example.test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
}

export function commitAll(dir, message = 'test: baseline') {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-gpg-sign', '-m', message]);
}

export function stage(dir, ...relativePaths) {
  git(dir, ['add', '--', ...relativePaths]);
}

export function makeRepo(t, { git: useGit = true, files = baseProject(), commit = true } = {}) {
  const dir = tempDir(t);
  writeFiles(dir, files);
  if (useGit) {
    initRepo(dir);
    if (commit) commitAll(dir);
  }
  return dir;
}

/**
 * 基线：一份完全合法的 living docs 树 + doc-map + 代码注释引用。
 * 任何用例都只在这棵树上做单向最小变更，失败原因才能被精确定位。
 */
export function baseProject() {
  return {
    '.gitignore': ['node_modules', 'node_modules/', 'tmp/', '.githooks/runtime', ''].join('\n'),

    'docs/README.md': `# 文档索引

> 结论：这是开发文档的唯一入口，所有 living 文档都在这里直接索引。

## 先读

- [文档规范](standards/documentation.md)
- [桌面 IPC 与 preload](architecture/desktop-ipc.md)
- [质量门禁](guides/quality.md)

## 运维

- [运维索引](runbooks/README.md)
- [服务恢复](runbooks/recovery.md)

## 冻结证据

- [冻结证据说明](reviews/README.md)

## 模块说明

- [项目说明](../README.md)
- [服务端说明](../server/README.md)
- [iOS 说明](../ios/README.md)
`,

    'README.md': `# qqpet

> 结论：qqpet 是共享宠物数据的多端应用。

## 1. 结构

桌面端、服务端与移动端共用同一份契约。

## 2. 命令

质量门禁见 docs/guides/quality.md。
`,

    'server/README.md': `# 服务端说明

> 结论：服务端是共享宠物数据的权威端。

## 1. 启动

运行 \`npm --prefix server run build\` 后启动。

## 2. 测试

运行 \`npm --prefix server test\`。
`,

    'ios/README.md': `# iOS 说明

> 结论：iOS 宿主通过原生桥复用同一份 window.qqpet 契约。

## 1. 构建

运行 \`npm run build:ios-web\`。

## 2. 约定

原生方法必须与桥接声明保持一致。
`,

    'docs/standards/documentation.md': `# 开发文档规范

> 结论：同一层语义只保留一份 living 文档，代码与文档在同一个 commit 更新。

## 1. 目录职责

living 文档只能放在 standards、specs、architecture、guides、runbooks 下。

## 2. 验证

提交前运行 \`node scripts/docs/check-docs.mjs\`。

## 3. 变更影响

文档路径变化时同步更新 [入口](../README.md)。
`,

    'docs/architecture/desktop-ipc.md': `# 桌面 IPC 与 preload 契约

> 结论：主进程通过具名 IPC 通道暴露能力，preload 只做白名单转发。

## 1. 通道契约

通道名在 src/shared/ipc.ts 中集中定义。

## 2. 失败模式

未知通道必须拒绝，而不是静默忽略。

## 3. 验证

运行 \`npm run test:compat\`。

## 4. 变更影响

修改通道或载荷时，同步更新 [质量门禁](../guides/quality.md)。
`,

    'docs/guides/quality.md': `# 质量门禁

> 结论：合并前必须通过 typecheck、测试与文档检查。

## 1. 命令

运行 \`npm run check:docs\` 与 \`npm run test:docs\`。

## 2. 退出码

0 通过，1 校验失败，2 工具或配置错误。

## 3. 证据

新证据写入 .agent-reports/acceptance。

## 4. 相关文档

参见 [文档规范](../standards/documentation.md) §1。
`,

    'docs/runbooks/README.md': `# 运维 Runbook 索引

> 结论：所有 runbook 必须在这里登记，再从文档入口链接。

## 1. 专项手册

| 手册 | 场景 |
| --- | --- |
| [服务恢复](recovery.md) | server 无法启动 |
`,

    'docs/runbooks/recovery.md': `# 服务恢复

> 结论：先确认 SQLite 锁与端口占用，再按顺序重启。

## 1. 触发条件

健康检查连续失败。

## 2. 处置步骤

1. 检查进程与端口。
2. 读取 server 日志。
3. 重启后验证 healthz。

## 3. 验证

\`curl -sf http://127.0.0.1:8787/healthz\` 返回 ok。
`,

    'docs/reviews/README.md': `# 冻结证据说明

> 结论：docs/reviews 下的验收证据只读，不再维护，也不新增。

## 1. 范围

历史验收报告与产物保持原样。

## 2. 新证据

新的验收输出写入 .agent-reports/acceptance。
`,

    'docs/reviews/c12-gate.md': `# C12 验收记录

> 结论：历史证据，只读。

- 日期：2026-11-18
- 结果：通过
`,

    'docs/doc-map.json': `${JSON.stringify(
      {
        version: 1,
        rules: [
          {
            include: ['src/main/**'],
            exclude: ['**/*.test.ts'],
            docs: ['docs/architecture/desktop-ipc.md'],
            mode: 'require',
            reason: '主进程契约变更',
          },
          {
            include: ['src/shared/**'],
            exclude: [],
            docs: ['docs/guides/quality.md'],
            mode: 'warn',
            reason: '共享逻辑变更提醒',
          },
        ],
      },
      null,
      2,
    )}\n`,

    'src/main/feature.ts': `// 契约见 docs/architecture/desktop-ipc.md §1。
export function feature(): string {
  return 'feature';
}
`,

    'src/main/other.ts': `export const other = 1;
`,

    'src/shared/util.ts': `// 质量门禁见 docs/guides/quality.md §1。
export const util = 1;
`,
  };
}

export function readDocMap(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, 'docs', 'doc-map.json'), 'utf8'));
}

export function writeDocMap(repo, value) {
  write(repo, 'docs/doc-map.json', `${JSON.stringify(value, null, 2)}\n`);
}

export function runCli(repo, args = [], { env = {}, nodeArgs = [] } = {}) {
  return spawnSync(process.execPath, [...nodeArgs, CLI_PATH, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: cleanEnv(env),
    timeout: 60_000,
  });
}

export function runInstallHooks(repo, args = [], { env = {} } = {}) {
  return spawnSync(process.execPath, [INSTALL_HOOKS_PATH, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: cleanEnv(env),
    timeout: 60_000,
  });
}

export function outputOf(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

export function reportOf(result) {
  const text = (result.stdout ?? '').trim();
  assert.ok(
    text.length > 0,
    `CLI 没有输出 JSON（exit=${result.status}）\nstderr:\n${result.stderr}`,
  );
  try {
    return JSON.parse(text);
  } catch (error) {
    assert.fail(
      `CLI 输出不是合法 JSON：${error.message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

export function issuesOf(report) {
  assert.ok(Array.isArray(report.issues), `full 报告缺少 issues 数组：${JSON.stringify(report)}`);
  return report.issues;
}

export function assertIssue(report, matcher, label) {
  const issues = issuesOf(report);
  assert.ok(
    issues.some(matcher),
    `${label}：issues 中没有匹配项\n${JSON.stringify(issues, null, 2)}`,
  );
}

export function assertNoIssue(report, matcher, label) {
  const issues = issuesOf(report);
  assert.ok(
    !issues.some(matcher),
    `${label}：出现了不应有的 issue\n${JSON.stringify(
      issues.filter(matcher),
      null,
      2,
    )}`,
  );
}

/** 把实现文件复制进临时仓库，让 hooks 用仓库内相对路径调用检查器。 */
export function copyImplementation(repo) {
  const scriptsDir = path.join(repo, 'scripts', 'docs');
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const name of ['doc-lib.mjs', 'check-docs.mjs', 'install-hooks.mjs']) {
    const source = path.join(REPO_ROOT, 'scripts', 'docs', name);
    assert.ok(fs.existsSync(source), `缺少实现文件 scripts/docs/${name}（D1 红灯预期）`);
    fs.copyFileSync(source, path.join(scriptsDir, name));
  }

  assert.ok(fs.existsSync(HOOKS_DIR), `缺少 .githooks 目录（D1 红灯预期）`);
  const destHooks = path.join(repo, '.githooks');
  fs.cpSync(HOOKS_DIR, destHooks, { recursive: true });
  fs.rmSync(path.join(destHooks, 'runtime'), { force: true });
  for (const name of ['pre-commit', 'commit-msg']) {
    const hookPath = path.join(destHooks, name);
    if (fs.existsSync(hookPath)) fs.chmodSync(hookPath, 0o755);
  }
}

export function writeRuntime(repo, nodePath = process.execPath) {
  const runtime = path.join(repo, '.githooks', 'runtime');
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(runtime, `${nodePath}\n`, 'utf8');
  fs.chmodSync(runtime, 0o755);
}

export function runHook(repo, hookName, args = [], { env = {} } = {}) {
  const hookPath = path.join(repo, '.githooks', hookName);
  assert.ok(fs.existsSync(hookPath), `缺少 hook：.githooks/${hookName}（D1 红灯预期）`);
  return spawnSync(hookPath, args, {
    cwd: repo,
    encoding: 'utf8',
    env: cleanEnv(env),
    timeout: 60_000,
  });
}

export function writeFakeOldNode(repo) {
  const fakePath = path.join(repo, '.fake-old-node');
  const realNode = process.execPath.replace(/"/g, '\\"');
  fs.writeFileSync(
    fakePath,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then',
      '  echo "v20.19.0"',
      '  exit 0',
      'fi',
      `exec "${realNode}" "$@"`,
      '',
    ].join('\n'),
    'utf8',
  );
  fs.chmodSync(fakePath, 0o755);
  return fakePath;
}

export function writeFakeNodeVersionModule() {
  const fakeModule = path.join(
    os.tmpdir(),
    `qqpet-fake-node-version-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`,
  );
  fs.writeFileSync(
    fakeModule,
    [
      "Object.defineProperty(process, 'version', { value: 'v20.19.0', configurable: true });",
      "try { Object.defineProperty(process.versions, 'node', { value: '20.19.0', configurable: true }); } catch {}",
      '',
    ].join('\n'),
    'utf8',
  );
  return fakeModule;
}
