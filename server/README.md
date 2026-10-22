# QQPet sync server

Standalone, single-pet-family authority server for desktop server mode. It owns
all canonical game logic, command ordering, revisions/event sequence, scheduler
catch-up, device authentication, and SQLite persistence. Desktop clients render
the authoritative projection and submit semantic commands over WebSocket.

This package is intentionally small in scope: one SQLite database and one server
process per deployment. It does not provide multi-tenancy, horizontal scaling,
billing, public account hosting, or a client-side simulation fallback.

## Runtime requirements

- Node.js 22 or newer. The server uses the built-in `node:sqlite` module, so the
  current release does not compile a native SQLite addon.
- One TLS WebSocket endpoint in production. Plain `ws://` is accepted only for
  loopback/self-test endpoints.
- Durable storage for the SQLite database and backups.
- For Docker, build from the repository root so the server can import
  `src/shared/**` at build time.

Useful commands:

```bash
# From the repository root
npm --prefix server ci
npm --prefix server run typecheck
npm --prefix server test
npm --prefix server run build
```

The built entrypoint is `server/dist/server/src/index.js`.

## Quick start (host process)

Use an absolute database path. The database and backup directories must be
writable by the server user.

```bash
export QQPET_SYNC_DB="$PWD/server/data/qqpet.sqlite"
export QQPET_SYNC_BACKUP_DIR="$PWD/server/data/backups"
export QQPET_SYNC_BIND=127.0.0.1
export QQPET_SYNC_PORT=8787
export QQPET_SYNC_TIME_ZONE=Asia/Shanghai
export QQPET_SYNC_WEATHER_LOCATION=北京
export QQPET_SYNC_ADVANCE_WHILE_EMPTY=1

mkdir -p "$(dirname "$QQPET_SYNC_DB")" "$QQPET_SYNC_BACKUP_DIR"
npm --prefix server run init -- --db "$QQPET_SYNC_DB" --pet-id default \
  --time-zone Asia/Shanghai --weather-city 北京
# The init output contains a one-time owner pairing code. Enter it in the
# desktop storage/pairing UI promptly; it expires after 10 minutes.

npm --prefix server start
```

The init command creates the canonical empty pet, engine state, authority row,
and initial owner pairing code. A process started against a database without an
initialized pet has nothing to serve; run `init` first.

Mint additional device pairing codes while the database is not being mutated by
another operator command, or use the packaged CLI against the same database:

```bash
npm --prefix server run pair -- --db "$QQPET_SYNC_DB" --pet-id default --role player
npm --prefix server run pair -- --db "$QQPET_SYNC_DB" --pet-id default --role owner
```

Pairing codes are single-use, expire after 10 minutes, and only a hash is
stored. The plaintext code is printed once. The first device created for a pet
is the owner; only owners can issue admin/server-setting/import/revoke commands.
A player may submit ordinary gameplay commands.

## HTTP and WebSocket endpoints

| Path | Method | Purpose |
|---|---|---|
| `/healthz` | GET | Liveness. Returns 200 while HTTP can respond. Body includes operational health. |
| `/readyz` | GET | Readiness. Returns 200 only when DB, scheduler, canonical state, and authority are ready; otherwise 503. |
| `/health` | GET | Detailed JSON health, including metrics/counters and scheduler state. No save contents or secrets. |
| `/v1/sync` | WebSocket upgrade | Canonical data plane. `/sync` is retained as an alias. |

Do not expose `/v1/sync` publicly as plain `ws://`. Use Caddy/Nginx or another
TLS terminator and forward WebSocket upgrade headers. Health responses include
revision, command/event sequence numbers, game time, scheduler catch-up state,
connection count, authority state/epoch/generation, and operational metrics;
they never include save JSON, pairing codes, device tokens, or session tokens.

## WebSocket protocol

The first client frame must be a `hello` with protocol version 1. It arrives
within 5 seconds; there is no query-string token and no Authorization header
token.

```jsonc
{
  "t": "hello",
  "v": 1,
  "requestId": "hello-1",
  "appVersion": "0.1.0",
  "petId": "default",
  "lastRevision": 12,
  "lastEventSeq": 18,
  "cachedAuthority": {
    "authorityId": "uuid",
    "restoreGeneration": 0,
    "epoch": 2
  },
  "auth": { "kind": "pairing", "code": "ONE_TIME_CODE", "deviceLabel": "Desktop" }
}
```

A reconnecting device sends
`"auth": { "kind": "token", "token": "<device-token>" }` and omits the pairing
code. The token is sent only inside the first WebSocket frame and is stored
hashed on the server. The server replies with `welcome`, a delivery plan
(`none`, `replay`, `snapshot`, or `replay+snapshot`), then optional replay and
snapshot frames, then `ready`. A `welcome` can carry a newly issued token once.

Client message types: `hello`, `command`, `commandStatus`, `exportBundle`,
`resync`, `ping`.

Server message types: `welcome`, `snapshot`, `replay`, `ready`, `projection`,
`commandResult`, `commandStatusResult`, `portableBundle`, `deviceRevoked`,
`authorityResetRequired`, `error`, `pong`.

An accepted command has a stable caller-generated `opId`:

```jsonc
{
  "t": "command",
  "v": 1,
  "requestId": "req-1",
  "opId": "feed-once-1",
  "observedRevision": 12,
  "command": { "type": "inventory.use", "payload": { "type": "food", "itemId": "102010001" } }
}
```

The server applies commands in arrival order. `observedRevision` is diagnostic;
it is not a compare-and-swap guard. Duplicate `opId` values from the same device
return the originally stored result with status `duplicate` and do not execute
again or consume RNG. If a socket drops before a result arrives, the client must
reconnect and send `commandStatus` for that `opId`. A result status is one of
`applied`, `rejected`, or `not_applied`. A `not_applied` command is not retried
blindly; the UI hydrates the latest projection and asks the user to retry with a
fresh `opId`.

Canonical state is delivered as full `snapshot`/`projection` frames. Revision and
event sequence are monotonic. A revision/event gap, a stale cache authority, or
a restore rollback triggers `resync`; the server responds with a full snapshot
and `ready`. `authorityResetRequired` instructs clients to discard their cached
authority and recover through a full snapshot. Players never receive detached
portable bundles or session answer keys.

Close codes:

| Code | Meaning |
|---|---|
| `4000` | Authentication failed |
| `4001` | Protocol version mismatch |
| `4002` | Session superseded, revoked, authority reset, or archived handoff |
| `4003` | Rate limited |
| `4004` | Invalid frame |
| `4005` | Payload too large |
| `4006` | Server error |

The server enforces a 16 MiB general frame limit, a 256 KiB command limit, a
16 MiB snapshot limit, 10 commands/second with burst 20 per device, 8
connections per pet, 20-second ping interval, and 60-second idle timeout by
default.

## Authentication and device lifecycle

- `init` creates the owner pairing code. `pair` mints an owner or player code.
- Codes contain at least 128 bits of randomness, are single-use, expire after
  10 minutes, and are stored only as hashes.
- Device tokens contain at least 256 bits of randomness and are stored only as
  hashes server-side. The plaintext token is returned once in `welcome`.
- The server rechecks the device row before every command, so revocation applies
  to already-authenticated sockets. On `device.revoke` it persists
  `revoked_at_ms` in a full-sync transaction, closes the revoked device's live
  sockets with code `4002`, broadcasts `deviceRevoked` to surviving sessions,
  rejects queued/subsequent commands, and fails later reconnect authentication.
- A client data plane never gets another device's token, pairing code, session
  token, answer key, archived bundle, or device-local settings.

### Operator device revocation

Running server: use the `ctl revoke-device` path. The credential file contains
an existing owner device token. The CLI sends it only in the first WebSocket
frame and does not log it.

```bash
node server/dist/server/src/index.js ctl revoke-device <device-id> \
  --pet-id default \
  --owner-admin-credential /etc/qqpet-sync/owner-admin-credential \
  --db "$QQPET_SYNC_DB" --bind 127.0.0.1 --port 8787
```

The current CLI connects over the configured loopback WebSocket endpoint to use
the same live command path as desktop owners. It is not a direct DB write. Keep
the bind address on loopback/firewalled interfaces and protect the credential
file as a secret.

Stopped server: the offline form updates the database directly. It requires the
server to be stopped and the operator to have filesystem access.

```bash
node server/dist/server/src/index.js revoke-device --offline \
  --db "$QQPET_SYNC_DB" --pet-id default --device-id <device-id>
```

The next server start rejects a revoked token during handshake.

## Environment and configuration reference

Values below are read by `server/src/config.ts` at process start. Use absolute
paths. Unknown environment variables are ignored.

| Variable | Default | Notes |
|---|---|---|
| `QQPET_SYNC_BIND` | `127.0.0.1` | HTTP/WebSocket bind address. Keep loopback when a local proxy terminates TLS. |
| `QQPET_SYNC_PORT` | `8787` | HTTP/WS port, `0..65535`. |
| `QQPET_SYNC_DB` | `$HOME/.local/share/qqpet-sync/qqpet.sqlite` | Absolute SQLite path. WAL mode and `synchronous=FULL` are enforced at open. |
| `QQPET_SYNC_BACKUP_DIR` | sibling `backups/` of DB | Absolute online-backup directory. |
| `QQPET_SYNC_RESTORE_GENERATION_FILE` | unset | External operator-recorded restore generation. It is never part of a DB backup. Required for rollback-restore fencing. |
| `QQPET_ADMIN_SOCKET` | sibling `admin-<hostname>.sock` of DB | Reserved local control-socket path. Current CLI control uses the loopback WebSocket path documented above. |
| `QQPET_OWNER_ADMIN_CREDENTIAL` | unset | Credential file path used by restore/control CLI when the flag is omitted. Keep mode `0600`. |
| `QQPET_SYNC_TIME_ZONE` | host IANA zone | Initial pet timezone. Runtime timezone changes are persisted per pet. |
| `QQPET_SYNC_WEATHER_LOCATION` | empty | Initial canonical server weather city. Empty means deterministic fallback/automatic behavior. |
| `QQPET_SYNC_ADVANCE_WHILE_EMPTY` | `1` | Seeds the initial `advanceWhileEmpty` setting. The runtime setting is persisted in SQLite afterwards. |
| `QQPET_SYNC_CATCHUP_CHUNK_TICKS` | `1440` | Maximum game minutes per bounded catch-up chunk. One game day equals 1440 ticks. |
| `QQPET_SYNC_COMMAND_RETENTION` | `10000` | Retained command/idempotency rows per pet. |
| `QQPET_SYNC_EVENT_RETENTION` | `10000` | Retained ordered UI event rows per pet. |
| `QQPET_SYNC_LOG_RETENTION_DAYS` | `30` | Structured-log retention setting. |
| `QQPET_SYNC_MAX_FRAME_BYTES` | `16777216` | General WebSocket frame ceiling. |
| `QQPET_SYNC_MAX_COMMAND_BYTES` | `262144` | Command payload ceiling. Admin import may use the snapshot ceiling. |
| `QQPET_SYNC_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |

These current-release limits are code defaults and are not environment
variables: snapshot limit 16 MiB, replay limit 10,000 events, 8 connections per
pet, 5-second hello timeout, 60-second idle timeout, 20-second ping interval,
10 commands/second with burst 20, 10-minute pairing TTL, and a 1-second
scheduler poll. Changing them requires a reviewed code/config change.

Important runtime policy:

- `advanceWhileEmpty=true`: the scheduler keeps advancing canonical world state
  while no authenticated clients are connected. Online-only counters and
  sign-in online-gift time do not accrue during unattended intervals.
- `advanceWhileEmpty=false`: canonical state freezes with zero authenticated
  clients. Reconnecting does not backfill the empty interval.
- Server restarts with `advanceWhileEmpty=true` catch up in bounded game-minute
  ticks from the persisted scheduler anchor. The same command/tick inputs and
  persisted RNG/schedule state produce the same canonical result.
- Timezone and weather-city changes are owner commands and take effect through
  persisted settings and subsequent projections.

## Health, logs, and metrics

`/readyz` is the operational readiness probe. A `ready` body requires a
writable DB, successful SQLite quick check, repaired/consistent coverage,
non-corrupt canonical pets, scheduler readiness, and active authority.

Structured JSON logs include events such as `server.started`, `command.committed`,
`backup.success`, `backup.failed`, and `server.stopped`. They include pet/device
and command identifiers plus revision/event sequence, duration, and error code,
but never payloads, save bodies, tokens, pairing codes, or answer keys. The
health JSON exposes counter groups for commands, auth, rate limits, backups, and
scheduler metrics. There is no separate Prometheus endpoint in this release;
scrape `/health` JSON if needed.

## Docker and Compose

Build from the repository root:

```bash
docker build -f server/Dockerfile -t qqpet-server .
```

The image is multi-stage, runs as the non-root `node` user, stores state under
`/var/lib/qqpet-sync`, exposes port 8787, and has a `/healthz` healthcheck.

The included Compose file runs the server plus Caddy in front of it:

```bash
cd server
cp .env.example .env
# Edit .env: set QQPET_DOMAIN to a DNS name pointing at this host.
# Create the owner credential file and make it owner-readable only.
install -m 0600 deploy/owner_admin_credential.example deploy/owner-admin-credential
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8787/readyz
```

`docker-compose.yml` uses:

- a named `qqpet-data` volume mounted at `/var/lib/qqpet-sync`;
- a read-only container root with a small writable `tmpfs` at `/tmp`;
- `no-new-privileges`;
- a server healthcheck and Caddy dependency on health;
- a loopback-only published server port (Caddy is the public ingress);
- a Compose secret for the owner admin credential.

Caddy obtains TLS certificates automatically and proxies WebSocket upgrades by
default. The server is not published on the public interface directly. If you
use a different hostname or an internal CA, edit `deploy/Caddyfile`.

Initialize a fresh Compose volume before pairing:

```bash
docker compose exec qqpet-sync node dist/server/src/index.js init \
  --db /var/lib/qqpet-sync/qqpet.sqlite --pet-id default \
  --time-zone Asia/Shanghai --weather-city 北京
```

Mint another device code:

```bash
docker compose exec qqpet-sync node dist/server/src/index.js pair \
  --db /var/lib/qqpet-sync/qqpet.sqlite --pet-id default --role player
```

Online backup inside Compose:

```bash
docker compose exec qqpet-sync node dist/server/src/index.js backup \
  --db /var/lib/qqpet-sync/qqpet.sqlite --pet-id default
docker compose exec qqpet-sync ls -l /var/lib/qqpet-sync/backups
```

Copy a backup out of the named volume before restore drills and keep a copy on
separate storage:

```bash
docker compose cp qqpet-sync:/var/lib/qqpet-sync/backups/<file>.sqlite ./backup.sqlite
```

### Caddy

`server/deploy/Caddyfile` is the recommended TLS path. It terminates HTTPS,
proxies `/v1/sync` with WebSocket upgrade support, and keeps long-lived sockets
open. Point `QQPET_DOMAIN` at a DNS name with ports 80/443 reachable for ACME.
Do not configure Caddy to proxy plain WebSocket to a public non-loopback
upstream.

### Nginx

`server/deploy/nginx.conf.example` shows the required pieces:

- TLS certificate/key paths;
- `Upgrade` and `Connection` headers;
- `proxy_http_version 1.1`;
- a long `proxy_read_timeout`/`proxy_send_timeout`;
- a 20 MiB client body limit;
- a 301 redirect from HTTP to HTTPS.

Replace the certificate paths/server name and include the file from the Nginx
`http {}` block.

## systemd deployment

Build and install the package as root, for example:

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin qqpet-sync
sudo install -d -o qqpet-sync -g qqpet-sync -m 0700 /opt/qqpet-sync
sudo cp -a server/package.json server/node_modules server/dist /opt/qqpet-sync/
sudo install -d -o qqpet-sync -g qqpet-sync -m 0700 /var/lib/qqpet-sync
sudo install -m 0644 server/deploy/qqpet-sync.service /etc/systemd/system/qqpet-sync.service
sudo install -m 0644 server/deploy/qqpet-sync-backup.service /etc/systemd/system/qqpet-sync-backup.service
sudo install -m 0644 server/deploy/qqpet-sync-backup.timer /etc/systemd/system/qqpet-sync-backup.timer
sudo install -m 0600 /dev/null /etc/qqpet-sync.env
```

Put non-secret configuration in `/etc/qqpet-sync.env`; use the reference in
`server/.env.example`. Put the owner credential in a separate `0600` file. The
unit sets `StateDirectory=qqpet-sync`, `ProtectSystem=strict`,
`ProtectHome=true`, `PrivateTmp=true`, `NoNewPrivileges=true`, and write access
only to `/var/lib/qqpet-sync`.

Initialize before the first service start:

```bash
sudo -u qqpet-sync env $(grep -v '^#' /etc/qqpet-sync.env | xargs) \
  /usr/bin/node /opt/qqpet-sync/dist/server/src/index.js init \
  --db /var/lib/qqpet-sync/qqpet.sqlite --pet-id default \
  --time-zone Asia/Shanghai --weather-city 北京
sudo systemctl daemon-reload
sudo systemctl enable --now qqpet-sync.service
sudo systemctl enable --now qqpet-sync-backup.timer
```

The backup timer runs daily at 03:15 with persistence and a random delay, using
the same SQLite online-backup API as the CLI. Set your own retention policy for
older backup files and verify a restore on a schedule.

## Backups

Use SQLite's online backup API through the packaged CLI or `SyncServer.backup`.
Do not copy a live `.sqlite` file with `cp`: it can capture an inconsistent
snapshot or miss WAL state.

Manual backup while the server is running:

```bash
node server/dist/server/src/index.js backup \
  --db /var/lib/qqpet-sync/qqpet.sqlite --pet-id default
```

Without `--output`, the backup is written under `QQPET_SYNC_BACKUP_DIR` with a
timestamped name. The active server and the backup command both use SQLite
locking/checkpointing safely. A pre-import backup is also created automatically
for canonical portable imports.

Recommended retention:

- keep at least 7 daily, 4 weekly, and 3 monthly verified backups;
- keep pre-restore and pre-migration copies until the change is accepted;
- store one copy off the server host;
- periodically run a restore drill and check `/readyz`, authority metadata,
  revision, and game time;
- protect backups as sensitive: they contain hashed device credentials, game
  state, session metadata, and canonical environment data, although not
  plaintext tokens or proxy private keys.

Verify a backup is a readable SQLite file with no foreign-key violations before
relying on it:

```bash
node --disable-warning=ExperimentalWarning -e \
  "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare('PRAGMA quick_check').get()); console.log(db.prepare('PRAGMA foreign_key_check').all()); db.close()" \
  backup.sqlite
```

Backup retention is independent of command/event-log retention: commands and
events may be pruned, but a backup remains a complete canonical snapshot.

## Restore and rollback runbook

Rollback restore is an operator action, not an ordinary command. It must be
fenced by a new authority UUID and an externally recorded restore generation so
that stale clients cannot keep reading or writing an old lineage.

1. Announce maintenance. Stop `qqpet-sync` gracefully so WAL is checkpointed and
   live sockets close:

   ```bash
   sudo systemctl stop qqpet-sync.service
   ```

2. Confirm there is no pending WAL data. The restore command refuses if a
   non-empty `qqpet.sqlite-wal` remains.

3. Copy the current DB aside for emergency rollback. Do the same for the
   external restore-generation file.

4. Run restore from a verified backup. `--accept-rollback` is mandatory and the
   requested generation must be greater than the current/recorded generation:

   ```bash
   sudo -u qqpet-sync /usr/bin/node /opt/qqpet-sync/dist/server/src/index.js restore \
     --db /var/lib/qqpet-sync/qqpet.sqlite \
     --from /var/lib/qqpet-sync/backups/default-2026-10-22T03-15-00.000Z.sqlite \
     --accept-rollback \
     --restore-generation 4 \
     --owner-admin-credential /etc/qqpet-sync/owner-admin-credential
   ```

   The CLI validates the whole candidate, applies the new authority UUID and
   generation in a staged copy, atomically swaps it into place, and writes the
   external generation fence. Repeated restores must always advance the
   generation and never reuse an authority UUID.

5. Start the service and verify readiness:

   ```bash
   sudo systemctl start qqpet-sync.service
   curl --fail http://127.0.0.1:8787/readyz
   ```

6. Keep clients running/reconnecting. If a client cached an authority newer than
   the restored one, the server sends `authorityResetRequired` and closes the
   stale socket. The client must discard its projection cache, reconnect without
   the stale cached authority, and accept a full snapshot before commands are
   enabled again. A read-only older cache is not a valid override.

7. If `advanceWhileEmpty=true`, the restarted server catches up from the restored
   anchor to wall time in bounded ticks. If `false` and no clients are connected,
   the restored state freezes until a client authenticates; there is no
   zero-client backfill.

8. Run a post-restore drill: verify health, authority id/generation, revision,
   event sequence, a harmless feed command, a second-client projection update,
   and a fresh backup. Record the restore generation in the operator log.

Restore drill example with a disposable copy: initialize a temp DB, adopt a pet,
backup, apply a few commands, restore the backup with generation 1, start the
service, and verify `/readyz` plus `authorityResetRequired` propagation from a
stale client. The C12 E2E test automates this fence against a real server and
two real Electron processes.

## Operations runbook

| Situation | Action |
|---|---|
| First deployment | Create DB dirs, run `init`, capture the one-time pairing code, start service behind TLS, pair owner, run `readyz`. |
| Pair another device | Stop ad-hoc DB writers, run `pair`, enter the one-time code on that device, confirm role. |
| Routine backup | Timer or `backup` CLI; verify quick check; copy off host; alert on failures. |
| Restore/rollback | Stop service, restore with advancing generation, start, verify readiness, watch clients resnapshot. |
| Revoke lost device | Running server `ctl revoke-device`; verify live sockets close and later reconnects fail. Use offline form only while stopped. |
| TLS/proxy change | Update Caddy/Nginx, keep WebSocket upgrade and long read timeout, verify `/readyz` and a desktop reconnect. |
| Disk pressure | Check DB/WAL/backups; do not delete WAL or open live DB files; move verified backups to separate storage. |
| Corrupt DB | Stop service, preserve files, restore latest verified backup with rollback fencing, then investigate disk/durability. |
| Scheduler not ready | Inspect `/readyz` `petHealth`, `catchingUp`, `wallLagMs`, `lastError`, and structured logs; restart only after preserving DB/backups. |
| Unexpected auth failures | Check rate-limit/auth metrics and device revocation; never log or paste plaintext tokens/codes. |

Graceful shutdown uses `SIGTERM`/`SIGINT`, stops the scheduler, finalizes coverage
operations, closes sessions and the WebSocket server, then closes SQLite. For
Docker use `docker compose stop` rather than killing the container, so the same
shutdown path runs.

## Security notes

- Production uses `wss://` only. Plain `ws://` is allowed only for loopback or
  explicitly self-testing endpoints; use a TLS proxy for any remote client.
- Do not expose the server port or `/health` publicly without edge controls.
  Caddy/Nginx should proxy only the intended host and paths.
- Tokens and pairing codes travel only inside the first WebSocket frame, never
  URLs, query strings, or headers. Keep logs free of raw auth frames.
- Device tokens and pairing codes are stored hashed. Device-local secrets
  (`aiKey`, `searchKey`, `webhookToken`) and local UI/window state are never part
  of a canonical projection or DB.
- Portable archived bundles are owner-only. Player sockets can receive authority
  status but never bundle contents, answer keys, RNG schedules, or session
  tokens.
- Run as an unprivileged user with `UMask=0077`. Restrict DB, backup, and
  credential files to the service account. Keep the owner admin credential and
  TLS private keys outside the DB and backup files.
- Set a size/time limit at the proxy as well as application limits. Reject
  non-WebSocket traffic and unexpected HTTP methods at the edge.
- Rate/size limits, auth TTLs, and revocation checks are Defensive controls, not
  protection for a hostile public multi-tenant service. This release does not
  claim that security model.

## Scope and residual limitations

- One SQLite database and one server process per pet family. No HA, replication,
  multi-writer, or Postgres/Redis mode.
- No public account system, billing, anti-cheat, or hosted service.
- Mobile server mode is hidden; mobile local runtime parity/build is a separate
  gate from this server package.
- Renderer/GUI is not exercised by the server test suite. The C12 E2E runner uses
  two real Electron main processes and the production RemoteRepository, without
  a BrowserWindow, and documents that boundary in
  `docs/superpowers/acceptance/`.
- `QQPET_ADMIN_SOCKET` is reserved configuration in this release. The live
  operator `ctl revoke-device` path currently uses a loopback WebSocket with an
  owner device token.
