import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = join(serverRoot, 'dist')

function filesUnder(directory) {
  const files = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) files.push(...filesUnder(path))
    else if (path.endsWith('.js')) files.push(path)
  }
  return files
}

function withJavaScriptExtension(specifier, fromFile) {
  if (!specifier.startsWith('.') || extname(specifier) !== '') return specifier
  const base = resolve(dirname(fromFile), specifier)
  if (existsSync(base + '.js')) return specifier + '.js'
  if (existsSync(join(base, 'index.js'))) return specifier + '/index.js'
  return specifier
}

for (const file of filesUnder(distRoot)) {
  const source = readFileSync(file, 'utf8')
  const rewritten = source.replace(
    /(\bfrom\s+|\bimport\s*\()(['"])([^'"]+)\2/g,
    (_match, prefix, quote, specifier) =>
      prefix + quote + withJavaScriptExtension(specifier, file) + quote,
  )
  if (rewritten !== source) writeFileSync(file, rewritten)
}
