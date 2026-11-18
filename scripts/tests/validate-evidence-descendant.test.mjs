import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VALIDATOR_SOURCE = resolve(HERE, '../validate-evidence.mjs')
const VALIDATOR_LIB_SOURCE = resolve(HERE, '../lib/acceptance-evidence.mjs')
const REPORT_RELATIVE_PATH = '.agent-reports/acceptance/artifacts/c12-docker/docker-smoke-report.json'

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed:\n' + result.stderr)
  return result.stdout.trim()
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'qqpet-evidence-revision-'))
  await mkdir(join(root, 'scripts/lib'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await copyFile(VALIDATOR_SOURCE, join(root, 'scripts/validate-evidence.mjs'))
  await copyFile(VALIDATOR_LIB_SOURCE, join(root, 'scripts/lib/acceptance-evidence.mjs'))
  await writeFile(join(root, 'src/main.ts'), 'export const value = 1\n')
  runGit(root, ['init', '--initial-branch=main'])
  runGit(root, ['config', 'user.name', 'Evidence Test'])
  runGit(root, ['config', 'user.email', 'evidence-test@example.invalid'])
  runGit(root, ['add', '-A'])
  runGit(root, ['commit', '-m', 'tested source tree'])
  return { root, testedRevision: runGit(root, ['rev-parse', 'HEAD']) }
}

function dockerReport(codeRevision) {
  const now = Date.now()
  return {
    result: 'PASS',
    codeRevision,
    startedAt: new Date(now - 2_000).toISOString(),
    finishedAt: new Date(now - 1_000).toISOString(),
    evidence: {
      imageBuilt: true,
      containerStarted: true,
      readyzReady: true,
      journalMode: 'wal',
      synchronous: 'full',
      nonRoot: true,
      uid: 1000,
      ownerAdminCredentialHashed: true,
      credentialReadableByRuntime: true,
      credentialRuntimeUid: 1000,
      credentialRuntimeMode: 0o400,
      backupCreated: true,
      backupContentAsserted: true,
      restoreSucceeded: true,
      restoreContentMatched: true,
      postRestoreReadyz: true,
      teardown: true,
    },
  }
}

async function writeReport(root, codeRevision, relativePath = REPORT_RELATIVE_PATH) {
  const reportPath = join(root, relativePath)
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(dockerReport(codeRevision), null, 2) + '\n')
  return reportPath
}

async function writeExternalReport(codeRevision) {
  const root = await mkdtemp(join(tmpdir(), 'qqpet-evidence-report-'))
  const reportPath = join(root, 'report.json')
  await writeFile(reportPath, JSON.stringify(dockerReport(codeRevision), null, 2) + '\n')
  return reportPath
}

function validateDocker(root, reportPath, extraEnv = {}) {
  const { QQPET_CODE_REVISION, ...env } = process.env
  return spawnSync(process.execPath, ['scripts/validate-evidence.mjs', 'docker', reportPath], {
    cwd: root,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  })
}

function commitAll(root, message) {
  runGit(root, ['add', '-A'])
  runGit(root, ['commit', '-m', message])
  return runGit(root, ['rev-parse', 'HEAD'])
}

test('evidence-only descendant report is accepted after the tested revision', async () => {
  const { root, testedRevision } = await createRepository()
  const reportPath = await writeReport(root, testedRevision)
  const headRevision = commitAll(root, 'record acceptance evidence')

  const result = validateDocker(root, reportPath)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /evidence-only descendant accepted/)
  assert.match(result.stdout, new RegExp('tested=' + testedRevision + ' head=' + headRevision))
  assert.match(result.stdout, /\[evidence\] PASS docker:/)
})

test('descendant that changes source is rejected with the strict revision error', async () => {
  const { root, testedRevision } = await createRepository()
  const reportPath = await writeReport(root, testedRevision)
  await writeFile(join(root, 'src/main.ts'), 'export const value = 2\n')
  const headRevision = commitAll(root, 'change source after evidence')

  const result = validateDocker(root, reportPath)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp('Docker smoke codeRevision ' + testedRevision
    + ' does not match current HEAD ' + headRevision))
  assert.doesNotMatch(result.stderr, /evidence-only descendant accepted/)
})

test('unrelated sibling/branch revision is rejected with the strict revision error', async () => {
  const { root, testedRevision: baseRevision } = await createRepository()
  runGit(root, ['checkout', '-b', 'tested'])
  await mkdir(join(root, '.agent-reports/acceptance'), { recursive: true })
  await writeFile(join(root, '.agent-reports/acceptance/tested-branch.txt'), 'tested\n')
  const testedRevision = commitAll(root, 'tested branch evidence')
  assert.notEqual(testedRevision, baseRevision)

  runGit(root, ['checkout', 'main'])
  await writeFile(join(root, 'src/sibling.ts'), 'export const sibling = true\n')
  const headRevision = commitAll(root, 'sibling source branch')
  const reportPath = await writeReport(root, testedRevision)

  const result = validateDocker(root, reportPath)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp('Docker smoke codeRevision ' + testedRevision
    + ' does not match current HEAD ' + headRevision))
  assert.doesNotMatch(result.stderr, /evidence-only descendant accepted/)
})

test('untracked source file invalidates the evidence-only descendant allowance', async () => {
  const { root, testedRevision } = await createRepository()
  const reportPath = await writeReport(root, testedRevision)
  const headRevision = commitAll(root, 'record acceptance evidence')
  await writeFile(join(root, 'src/untracked-source.ts'), 'export const bypass = true\n')

  const result = validateDocker(root, reportPath)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp('Docker smoke codeRevision ' + testedRevision
    + ' does not match current HEAD ' + headRevision))
  assert.doesNotMatch(result.stdout + result.stderr, /evidence-only descendant accepted/)
})

test('tracked working-tree replacement report invalidates the evidence-only descendant allowance', async () => {
  const { root, testedRevision } = await createRepository()
  const reportPath = await writeReport(root, testedRevision)
  const headRevision = commitAll(root, 'record acceptance evidence')
  await writeReport(root, testedRevision)

  const result = validateDocker(root, reportPath)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp('Docker smoke codeRevision ' + testedRevision
    + ' does not match current HEAD ' + headRevision))
  assert.doesNotMatch(result.stdout + result.stderr, /evidence-only descendant accepted/)
})

test('untracked replacement report invalidates the evidence-only descendant allowance', async () => {
  const { root, testedRevision } = await createRepository()
  await writeReport(root, testedRevision)
  const headRevision = commitAll(root, 'record acceptance evidence')
  const replacementRelativePath = '.agent-reports/acceptance/artifacts/c12-docker/replacement-report.json'
  const replacementPath = await writeReport(root, testedRevision, replacementRelativePath)

  const result = validateDocker(root, replacementPath)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp('Docker smoke codeRevision ' + testedRevision
    + ' does not match current HEAD ' + headRevision))
  assert.doesNotMatch(result.stdout + result.stderr, /evidence-only descendant accepted/)
})

test('missing report revision is still rejected', async () => {
  const { root } = await createRepository()
  const reportPath = await writeReport(root, '')
  commitAll(root, 'record malformed evidence')

  const result = validateDocker(root, reportPath)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /must include a non-empty codeRevision/)
})

test('fabricated configured revision equal to the report revision cannot replace real HEAD', async () => {
  const { root } = await createRepository()
  const fabricatedRevision = '1'.repeat(40)
  const realHead = runGit(root, ['rev-parse', 'HEAD'])
  const reportPath = await writeExternalReport(fabricatedRevision)

  const result = validateDocker(root, reportPath, { QQPET_CODE_REVISION: fabricatedRevision })
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp('configured revision ' + fabricatedRevision
    + ' differs from real HEAD ' + realHead))
  assert.match(result.stderr, /not a clean evidence-only descendant/)
  assert.match(result.stderr, /does not match current HEAD/)
  assert.doesNotMatch(result.stdout, /\[evidence\] PASS docker:/)
})

test('untracked source is rejected when the report revision equals real HEAD', async () => {
  const { root, testedRevision } = await createRepository()
  const reportPath = await writeExternalReport(testedRevision)
  const cleanResult = validateDocker(root, reportPath)
  assert.equal(cleanResult.status, 0, cleanResult.stderr)

  await writeFile(join(root, 'src/untracked-equal-revision.ts'), 'export const bypass = true\n')
  const result = validateDocker(root, reportPath)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /working tree must be clean before evidence validation/)
  assert.match(result.stderr, /src\/untracked-equal-revision\.ts/)
  assert.doesNotMatch(result.stdout, /\[evidence\] PASS docker:/)
})
