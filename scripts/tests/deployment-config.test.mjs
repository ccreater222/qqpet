import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')

function locationBlock(nginx, path) {
  const marker = 'location = ' + path + ' {'
  const start = nginx.indexOf(marker)
  assert.ok(start >= 0, 'missing Nginx location ' + path)
  const end = nginx.indexOf('\n    }', start)
  assert.ok(end > start, 'unterminated Nginx location ' + path)
  return nginx.slice(start, end + 6)
}

test('Compose requires an explicit owner token secret and stages it for the non-root runtime', async () => {
  const compose = await read('server/docker-compose.yml')
  assert.match(compose, /env_file:\s*\n\s*- \$\{QQPET_OWNER_ADMIN_CREDENTIAL_FILE:\?[^}]+\}/)
  assert.match(compose, /^secrets:\s*\n\s{2}owner_admin_credential:\s*\n\s{4}file: \$\{QQPET_OWNER_ADMIN_CREDENTIAL_FILE:\?[^}]+\}/m)
  assert.match(compose, /secrets:\s*\n\s*- source: owner_admin_credential\s*\n\s*target: owner_admin_credential/)
  assert.match(compose, /QQPET_OWNER_ADMIN_CREDENTIAL: \/run\/qqpet-secrets\/owner_admin_credential/)
  assert.match(compose, /QQPET_OWNER_ADMIN_CREDENTIAL_SOURCE: \/run\/secrets\/owner_admin_credential/)
  assert.match(compose, /entrypoint: \["\/bin\/sh", "\/usr\/local\/bin\/qqpet-docker-entrypoint\.sh"\]/)
  assert.match(compose, /user: "0:0"/)
  assert.equal(compose.includes('source: ${QQPET_OWNER_ADMIN_CREDENTIAL_FILE:?'), false)
  assert.equal(compose.includes('${QQPET_OWNER_ADMIN_CREDENTIAL_FILE:-'), false)
  assert.equal(compose.includes('owner_admin_credential.example'), false)
  await assert.rejects(read('server/deploy/owner_admin_credential.example'))
})

test('README documents the existing owner token, 0600 host file and container secret staging', async () => {
  const readme = await read('server/README.md')
  const envExample = await read('server/.env.example')
  assert.match(readme, /QQPET_OWNER_ADMIN_CREDENTIAL_FILE=\.\/deploy\/owner-admin-credential/)
  assert.match(readme, /must contain the token of a non-revoked owner device/)
  assert.match(readme, /chmod 0600 deploy\/owner-admin-credential/)
  assert.match(readme, /QQPET_OWNER_ADMIN_CREDENTIAL=\/run\/qqpet-secrets\/owner_admin_credential/)
  assert.match(readme, /QQPET_OWNER_ADMIN_CREDENTIAL_SOURCE=\/run\/secrets\/owner_admin_credential/)
  assert.equal(readme.includes('openssl rand -hex 32 > deploy/owner-admin-credential'), false)
  assert.match(envExample, /QQPET_OWNER_ADMIN_CREDENTIAL_FILE=\.\/deploy\/owner-admin-credential/)
  assert.equal(envExample.includes('owner_admin_credential.example'), false)
  assert.equal(readme.includes('owner_admin_credential.example'), false)
})

test('container entrypoint copies the secret with node ownership and then drops root', async () => {
  const entrypoint = await read('server/docker-entrypoint.sh')
  const dockerfile = await read('server/Dockerfile')
  assert.match(entrypoint, /install -d -o "\$NODE_UID" -g "\$NODE_GID" -m 0700 "\$TARGET_DIR"/)
  assert.match(entrypoint, /install -m 0400 -o "\$NODE_UID" -g "\$NODE_GID" "\$SOURCE_PATH" "\$TARGET_PATH"/)
  assert.match(entrypoint, /exec setpriv --reuid="\$NODE_UID" --regid="\$NODE_GID" --clear-groups node dist\/server\/src\/index\.js/)
  assert.match(dockerfile, /COPY --chown=root:root server\/docker-entrypoint\.sh \/usr\/local\/bin\/qqpet-docker-entrypoint\.sh/)
})

test('Nginx example proxies every documented health and WebSocket route with upgrade headers', async () => {
  const nginx = await read('server/deploy/nginx.conf.example')
  for (const path of ['/v1/sync', '/sync']) {
    const block = locationBlock(nginx, path)
    assert.match(block, /proxy_pass http:\/\/qqpet_sync;/)
    assert.match(block, /proxy_http_version 1\.1;/)
    assert.match(block, /proxy_set_header Upgrade \$http_upgrade;/)
    assert.match(block, /proxy_set_header Connection \$connection_upgrade;/)
  }
  for (const path of ['/health', '/healthz', '/readyz']) {
    const block = locationBlock(nginx, path)
    assert.match(block, /proxy_pass http:\/\/qqpet_sync;/)
  }
  assert.match(nginx, /location \/ \{\s+return 404;/)
})

test('Caddy keeps the same health routes and proxies WebSocket traffic automatically', async () => {
  const caddy = await read('server/deploy/Caddyfile')
  const healthMatcher = caddy.match(/^@health path((?: \/[^\s]+)+)$/m)
  assert.ok(healthMatcher, 'missing Caddy @health route matcher')
  const healthPaths = healthMatcher[1].trim().split(/\s+/)
  for (const path of ['/healthz', '/health', '/readyz']) {
    assert.ok(healthPaths.includes(path), 'Caddy @health matcher is missing ' + path)
  }
  assert.match(caddy, /handle @health \{\s+reverse_proxy qqpet-sync:8787\s+\}/)
  assert.match(caddy, /reverse_proxy qqpet-sync:8787/)
})

test('the acceptance workflow runs Docker/proxy smokes and release depends on it', async () => {
  const ci = await read('.github/workflows/ci.yml')
  const build = await read('.github/workflows/build.yml')
  assert.match(ci, /\n  docker-smoke:\n/)
  assert.match(ci, /\n  proxy-wss:\n/)
  assert.match(ci, /npm run smoke:docker/)
  assert.match(ci, /npm run smoke:proxy/)
  assert.match(ci, /validate-evidence\.mjs e2e/)
  assert.match(build, /^  acceptance:$/m)
  assert.match(build, /^    uses: \.\/\.github\/workflows\/ci\.yml$/m)
  assert.match(build, /^  release:$/m)
  assert.match(build, /^    needs: \[acceptance, build, android, harmony, ios\]$/m)
})
