import type { ServerConfig } from './config.js'

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

const RANK = { debug: 10, info: 20, warn: 30, error: 40 } as const
const FORBIDDEN_FIELD = /(?:token|pairing|secret|credential|password|save|payload|authorization|authframe)/i

function safeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (fields === undefined) return {}
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_FIELD.test(key)) continue
    if (typeof value === 'string' && value.length > 256) output[key] = value.slice(0, 256) + '…'
    else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) output[key] = value
    else if (key === 'error') output[key] = value instanceof Error ? value.message : 'internal_error'
  }
  return output
}

export function createLogger(config: Pick<ServerConfig, 'logLevel'>): Logger {
  const threshold = RANK[config.logLevel]
  const write = (level: keyof typeof RANK, event: string, fields?: Record<string, unknown>): void => {
    if (RANK[level] < threshold) return
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...safeFields(fields),
    })
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
    else process.stdout.write(line + '\n')
  }
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  }
}
