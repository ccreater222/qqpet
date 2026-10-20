import { readFileSync } from 'node:fs'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'

const traverse = traverseModule.default ?? traverseModule
const TASKS_URL = new URL('../../src/renderer/pet/tasks.ts', import.meta.url)
const BANG = String.fromCharCode(33)

function literal(node) {
  if (node == null) return undefined
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral' || node.type === 'BooleanLiteral') return node.value
  if (node.type === 'NullLiteral') return null
  if (node.type === 'Identifier' && node.name === 'DDW') return '点击逗乐点位'
  if (node.type === 'UnaryExpression') {
    if (node.operator === '-' && node.argument.type === 'NumericLiteral') return -node.argument.value
    throw new Error('unsupported unary expression in task source')
  }
  if (node.type === 'TemplateLiteral') {
    if (node.expressions.length > 0) throw new Error('unsupported template expression in task source')
    return node.quasis.map(part => part.value.cooked ?? part.value.raw).join('')
  }
  if (node.type === 'ArrayExpression') return node.elements.map(literal)
  if (node.type === 'ObjectExpression') {
    const out = {}
    for (const property of node.properties) {
      if (property.type === 'ObjectProperty') {
        const key = property.key.type === 'Identifier' ? property.key.name
          : property.key.type === 'StringLiteral' ? property.key.value
            : null
        if (key === null) throw new Error('unsupported object key in task source')
        out[key] = literal(property.value)
      } else {
        throw new Error('unsupported object property in task source')
      }
    }
    return out
  }
  throw new Error('unsupported AST node in task source: ' + node.type)
}

function propertyKey(property) {
  if (property.type === 'ObjectProperty') {
    if (property.key.type === 'Identifier') return property.key.name
    if (property.key.type === 'StringLiteral') return property.key.value
  }
  return null
}

function sourceOf(node, source) {
  return source.slice(node.start, node.end).replace(/\s+/g, ' ').trim()
}

function needKindFor(source) {
  if (source.includes('info.hunger')) return 'hungerLow'
  if (source.includes('info.clean')) return 'cleanLow'
  if (source.includes('info.mood')) return 'moodLow'
  if (source.includes('info.yb')) return 'ybLow'
  if (source.includes(BANG + 'off')) return 'studyDay'
  if (source.includes('off')) return 'dayOff'
  throw new Error('cannot classify renderer task need: ' + source)
}

function readTaskSource() {
  const source = readFileSync(TASKS_URL, 'utf8')
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  let tasksNode = null
  let kindsNode = null
  traverse(ast, {
    VariableDeclarator(path) {
      if (path.node.id.type === 'Identifier') {
        if (path.node.id.name === 'TASKS') tasksNode = path.node.init
        if (path.node.id.name === 'KINDS') kindsNode = path.node.init
      }
    },
  })
  if (tasksNode === null || kindsNode === null) throw new Error('could not find renderer TASKS/KINDS tables')
  if (tasksNode.type === 'ObjectExpression') {
    const tasks = literal(tasksNode)
    if (kindsNode.type === 'ArrayExpression') {
      const kinds = kindsNode.elements.map(element => {
        if (element == null || element.type !== 'ObjectExpression') throw new Error('unexpected KINDS entry')
        const fields = {}
        let needsKind = null
        let needsSource = null
        let canSource = null
        let canLevelTwo = false
        let hasCan = false
        for (const property of element.properties) {
          const key = propertyKey(property)
          if (key === 'needs') {
            needsSource = sourceOf(property.value, source)
            needsKind = needKindFor(needsSource)
          } else if (key === 'can') {
            hasCan = true
            canSource = sourceOf(property.value, source)
            canLevelTwo = /level\s*>=\s*2/.test(canSource)
          } else if (key !== null) {
            fields[key] = literal(property.value)
          }
        }
        return { ...fields, needsKind, needsSource, canSource, canLevelTwo, hasCan }
      })
      return { tasks, kinds }
    }
  }
  throw new Error('unexpected renderer task table shape')
}

export function readRendererTaskTables() {
  return readTaskSource()
}
