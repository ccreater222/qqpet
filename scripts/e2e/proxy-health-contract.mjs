/**
 * Contract for unauthenticated health responses used by the TLS/WSS proxy
 * smoke. `/health` and `/readyz` intentionally expose aggregate operability
 * only; detailed SQLite diagnostics and pet-scoped fields require owner auth.
 */
export const PUBLIC_HEALTH_FIELDS = Object.freeze([
  'ok',
  'service',
  'live',
  'ready',
  'pets',
  'catchingUp',
  'databaseReady',
  'hasError',
])

const PUBLIC_FIELD_SET = new Set(PUBLIC_HEALTH_FIELDS)

function isRecord(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

/**
 * Validate a public health HTTP response without accepting detailed/private
 * fields. Returning errors keeps the smoke report useful while the test can
 * assert the same contract independently.
 */
export function validatePublicHealthResponse(status, body) {
  const errors = []
  if (status !== 200) errors.push('status must be 200')
  if (isRecord(body) === false) {
    errors.push('body must be a JSON object')
    return { ok: false, errors }
  }
  if (body.ok !== true) errors.push('ok must be true')
  if (body.service !== 'qqpet-server') errors.push("service must be 'qqpet-server'")
  if (body.live !== true) errors.push('live must be true')
  if (typeof body.ready !== 'boolean') errors.push('ready must be a boolean')
  if (Number.isSafeInteger(body.pets) === false || body.pets < 0) {
    errors.push('pets must be a non-negative integer')
  }
  if (typeof body.catchingUp !== 'boolean') errors.push('catchingUp must be a boolean')
  if (body.databaseReady !== true) errors.push('databaseReady must be true')
  if (typeof body.hasError !== 'boolean') errors.push('hasError must be a boolean')

  const unexpected = Object.keys(body)
    .filter(field => PUBLIC_FIELD_SET.has(field) === false)
    .sort()
  if (unexpected.length > 0) {
    errors.push('unexpected public health fields: ' + unexpected.join(', '))
  }
  return { ok: errors.length === 0, errors }
}
