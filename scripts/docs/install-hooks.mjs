#!/usr/bin/env node
/**
 * 把仓库的 core.hooksPath 指向 .githooks，并记录当前 Node 绝对路径。
 *
 * 安全边界：
 * - 已有其它 core.hooksPath 时绝不覆盖；显式安装失败，prepare 只警告；
 * - .githooks 下已有非本仓库管理的 pre-commit/commit-msg 时拒绝接管；
 * - --worktree 使用 extensions.worktreeConfig + git config --worktree；
 * - 本脚本不生成 hook 内容，hook 文件随仓库提交。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const MANAGED_MARKER = 'qqpet-docs-hook: managed';
const MANAGED_HOOKS = ['pre-commit', 'commit-msg'];

function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(SCRIPT_PATH);
  } catch {
    return path.resolve(entry) === path.resolve(SCRIPT_PATH);
  }
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function gitTry(root, args) {
  try {
    return git(root, args);
  } catch {
    return '';
  }
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['--prepare', '--worktree']);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    fail(`未知参数：${unknown.join(' ')}；仅支持 --prepare、--worktree`);
    return;
  }

  const prepare = args.includes('--prepare')
    || process.env.npm_lifecycle_event === 'prepare';
  const worktree = args.includes('--worktree');

  let root;
  try {
    root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  } catch {
    if (prepare) {
      console.warn('警告：当前目录不是 git 仓库，跳过 docs hooks 安装。');
      return;
    }
    fail('当前目录不是 git 仓库，无法安装 docs hooks。');
    return;
  }

  const hooksDir = path.join(root, '.githooks');
  const customHooks = [];
  for (const name of MANAGED_HOOKS) {
    const content = readIfExists(path.join(hooksDir, name));
    if (content !== null && !content.includes(MANAGED_MARKER)) customHooks.push(name);
  }
  if (customHooks.length > 0) {
    const message =
      `检测到已有自定义 .githooks/${customHooks.join('、')}，未覆盖。`
      + '请手动把文档检查接入现有 hook，或先移走自定义 hook 再安装。';
    if (prepare) console.warn(`警告：${message}`);
    else fail(message);
    return;
  }

  const current = gitTry(root, ['config', '--get', 'core.hooksPath']);
  const normalized = current.replace(/\\/g, '/').replace(/\/+$/, '');
  const isDefault = !normalized
    || normalized === '.git/hooks'
    || normalized.endsWith('/.git/hooks');
  const isOurs = normalized === '.githooks' || normalized === './.githooks';

  if (!isDefault && !isOurs) {
    const message =
      `检测到已有 core.hooksPath=${current}，未覆盖。`
      + '请把文档检查接入现有 hook，或手动把 core.hooksPath 设为 .githooks。';
    if (prepare) console.warn(`警告：${message}`);
    else fail(message);
    return;
  }

  // 切换到 .githooks 会让旧默认目录里的自定义 hook 静默失效。
  // 只在确实要切换时检查；已经指向 .githooks 时旧目录本就不生效。
  if (!isOurs) {
    const legacyHooksDirRaw = gitTry(root, ['rev-parse', '--git-path', 'hooks']);
    const legacyHooksDir = legacyHooksDirRaw
      ? (path.isAbsolute(legacyHooksDirRaw)
        ? legacyHooksDirRaw
        : path.join(root, legacyHooksDirRaw))
      : path.join(root, '.git', 'hooks');
    const legacyCustom = [];
    for (const name of MANAGED_HOOKS) {
      const content = readIfExists(path.join(legacyHooksDir, name));
      if (content !== null && !content.includes(MANAGED_MARKER)) {
        legacyCustom.push(path.join(legacyHooksDir, name));
      }
    }
    if (legacyCustom.length > 0) {
      const message =
        `检测到旧默认 hooks 目录已有自定义 hook：${legacyCustom.join('、')}，未覆盖。`
        + '切换 core.hooksPath=.githooks 会静默禁用它们；请先移走或手动接入。';
      if (prepare) console.warn(`警告：${message}`);
      else fail(message);
      return;
    }
  }

  if (worktree) {
    git(root, ['config', 'extensions.worktreeConfig', 'true']);
    git(root, ['config', '--worktree', 'core.hooksPath', '.githooks']);
    console.log('已设置 worktree 级 core.hooksPath=.githooks。');
  } else if (isOurs) {
    console.log('core.hooksPath 已是 .githooks，无需重复安装。');
  } else {
    git(root, ['config', 'core.hooksPath', '.githooks']);
    console.log(`已设置 core.hooksPath=.githooks（仓库：${path.basename(root)}）。`);
  }

  fs.mkdirSync(hooksDir, { recursive: true });
  const runtimePath = path.join(hooksDir, 'runtime');
  fs.writeFileSync(runtimePath, `${process.execPath}\n`, 'utf8');
  fs.chmodSync(runtimePath, 0o755);
}

if (isEntryPoint()) {
  main();
}
