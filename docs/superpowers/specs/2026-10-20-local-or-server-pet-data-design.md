# Local or Server Pet Data Storage — Full Server-Authoritative Design

- **Status:** Revised draft for human approval; implementation has not started.
- **Date:** 2026-10-20
- **Scope:** Desktop-first MVP for QQPet
- **Architecture owner:** architect
- **Supersedes:** the previous lease/delegated-simulation draft. Leaseholder simulation is rejected and is not part of this design.
- **Approval gate:** design builder-check, then explicit human approval; no product code before approval.

## 1. Decision summary

D1 is resolved: **in server mode the server owns and advances all game logic**. The server computes hunger, growth, tasks, jobs, travel, games rewards, shop/inventory, mail, sign-in, farm/fishing, random events, and every other canonical SaveData mutation. Clients are projections: they render authoritative state and submit semantic user commands only.

The same deterministic, DOM-free pet runtime is used by:

- the server, as the only authority in server mode; and
- the Electron main process `LocalRepository`, as the local authority, so local and server mode do not drift semantically.

There is no leaseholder and no client-computed tick patch. No client may mutate canonical values through `SavePatch` or any direct state write. `SavePatch` remains a legacy local persistence detail if temporarily required during migration; it is never a server protocol message and is not an accepted way to change canonical state. No other architectural decision is open; concrete defaults that require human acceptance are listed in §19.3.

## 2. Scope and non-goals

### 2.1 In scope

- User-selectable storage backend: local or server.
- One `PetRepository` contract. Electron main selects `LocalRepository` or `RemoteRepository`; mobile bridges host `LocalRepository` only.
- A shared deterministic runtime in `src/shared/pet-runtime/**` used by both LocalRepository and the server.
- Server-authoritative command handling, scheduler, clock, RNG, offline/catch-up behavior, snapshot, revision, command/event log, idempotency, device auth, and SQLite WAL persistence.
- WebSocket data plane for command and projection synchronization.
- Two desktop Electron instances open on one pet; accepted feed/action on A becomes visible on B in near real time.
- Full feature parity in server mode: farm, fishing, island, small games, mail, sign-in, jobs, travel, shop/inventory, diary/album, and all other canonical SaveData mutations.
- `advanceWhileEmpty` server setting with continuous-advance and frozen semantics.
- Local-mode migration to the same runtime and command semantics.
- Desktop is the only server-mode host in this phase. Android/Harmony/iOS local mode remains in scope and must run the same shared runtime through a bridge-hosted LocalRepository; server mode is hidden on mobile.

### 2.2 Non-goals

- Multi-tenant public service, account system, billing, anti-cheat, or public pet hosting.
- Horizontal scale, multi-instance server, Postgres/Redis, cross-region replication, or HA failover.
- Mobile server mode, mobile WebSocket transport, and server-side SWF/DOM rendering in this phase. Local mobile runtime hosting is required.
- Client-side canonical simulation, client tick commits, client RNG decisions, or offline command queues.
- Server-side rendering of pet animation/SWF; clients still own presentation.
- Syncing device UI/display/position settings or secrets.
- Persisting arbitrary client-generated narration as authoritative game state.

## 3. Current-code facts that constrain the migration

These are facts about the current repo, not proposals.

### 3.1 Local save and IPC

| Fact | Current evidence | Consequence |
|---|---|---|
| Desktop save is `userData/save.json`. | `src/main/save.ts:10` | Local mode and the server-mode cache must migrate this path without silent data loss. |
| Writes are atomic tmp+rename with busy retries. | `src/main/save.ts:36-38`, `src/main/atomic-write.ts:10-22` | Reuse for the local projection document. |
| `loadSave()` writes immediately. | `src/main/save.ts:55-59` | Migration must back up before replacing the old bare SaveData format. |
| `save` IPC is fire-and-forget. | `src/preload/index.ts:4-14` | Server mode cannot retain this as a canonical mutation path; commands need results/idempotency. |
| Electron has no save flush barrier. | `src/main/index.ts:190-194` | `PetRepository.flush()` must be implemented and called on quit/pagehide. |
| Renderer batches shallow patches every 200ms. | `src/renderer/pet/store.ts:47-62` | Patch semantics are not an operation model; command UI migration is required. |
| `SavePatch` merges one object level, replaces arrays/scalars. | `src/shared/save.ts:178-181`, `src/shared/save-logic.ts:262-270` | Legacy patch application may remain only for local persistence migration; never on the server wire. |
| `saveNum` is a counter, never a CAS revision. | `src/shared/save-logic.ts:262-270` | The server `revision` is new and independent. |
| Game windows have no preload and no save access. | `src/main/window.ts:145-152` | Game UI must report semantic game-session intent; only main repository/server can change canonical state. |
| Mobile bridges currently own their own save/write paths. | `src/android/bridge.ts:104-123`; `src/harmony/bridge.ts:92-109`; `src/ios/bridge.ts:96-99,445-480` | Each must host the shared LocalRepository/runtime and the same v2 document; no renderer rule loops remain authoritative. |

### 3.2 Current simulation is renderer-owned and mixes rules with presentation

| Fact | Current evidence | Consequence |
|---|---|---|
| Growth is a renderer 60s interval using local wall time and randomness. | `src/renderer/pet/pet.ts:337-379`, `455-463` | Must become a server/local engine minute scheduler with injected clock and RNG. |
| Health/illness rolls use `Math.random()` and local weather. | `src/renderer/pet/pet.ts:409-422` | Must become deterministic runtime functions with RNG state and injected weather inputs. |
| Offline task progress is derived by the renderer from `save.nowTimeLine`. | `src/renderer/pet/jobs.ts:221-229`, `src/renderer/main.ts:489-492` | Must move into engine scheduler/deadline state; clients never backfill. |
| Online time and online-gift countdown currently accrue in the same minute tick as world effects. | `src/renderer/pet/pet.ts:349-353`, `src/renderer/pet/signin.ts:91-95` | Runtime must split game-clock effects from session-clock effects using `sessionActive`/`activeClientCount`. |
| Many rule modules mutate the renderer store directly: items, jobs, tasks, sign-in, fishing, farm, island, games, face, visits. | `src/renderer/pet/items.ts`, `jobs.ts`, `tasks.ts`, `signin.ts`, `fishing.ts`; `src/renderer/ui/farm.ts`, `island.ts`, `games.ts`, `face.ts`, `visit.ts` | These are the command catalog and runtime-extraction source set. |
| `info` and `settings` are object aliases held by DOM/UI modules. | `src/renderer/pet/store.ts:12`, `src/renderer/ui/setup.ts:270` | Hydration must preserve identities and merge in place. |
| `lastX` is updated at 12 Hz while walking. | `src/renderer/pet/pet.ts:133-149` | Position is device-local and must never become a command or shared state field. |
| Farm's live rules are partly in the Ruffle SWF and localStorage. | `src/renderer/ui/farm.ts:8-15`, `48-82`, `86-96` | Full server engine requires reimplementing/porting rules that currently live outside TypeScript; this is a high-risk extraction group. |
| Fishing SWF requests are translated to state mutations in TypeScript. | `src/renderer/pet/fishing.ts:207-219`, `src/renderer/ui/fishing.ts:43-74` | Fishing must move behind semantic commands; SWF remains a presentation client. |
| Island and community state includes UI-generated narration and position. | `src/renderer/ui/island.ts:839-891`, `src/renderer/ui/community.ts:303-313` | Canonical decisions must be separated from local presentation/prose/position. |
| Memory/chat files are separate from SaveData. | `src/main/memory.ts:15-16` | They remain device-local in this phase. |

### 3.3 Current packaging/CI

- Root package is private and has no workspaces (`package.json`).
- Electron-builder ships `out/**` plus resources (`electron-builder.yml:6-15`); the server must be a separate package.
- PR CI runs typecheck and `npm run test:compat` (`.github/workflows/ios-compat.yml:53-59`); tag build does not run the full test suite.
- Desktop single-instance lock is per userData (`src/main/index.ts:25-26`, `39`), enabling two test instances with `QQPET_USER_DATA` directories.
- Existing CDP helper is available at `tools/cdp.mjs:4-6` for two-instance E2E automation.
- Mobile Vite builds import `src/shared/**` into bridge bundles (`vite.android.config.ts`, `vite.harmony.config.ts`, `vite.ios.config.ts`); shared runtime code must stay DOM-free and Safari-14-compatible so all local hosts can import it. `tsconfig.web.json`/`tsconfig.harmony.json` include the shared sources; mobile bridge tests must cover the shared command/projection contract.

## 4. Target architecture

```text
┌──────────────────────── Electron renderer ────────────────────────┐
│ business UI / panels / SWF presentation                           │
│ SaveData projection only: apply ordered projections, render       │
│ submit semantic commands; never mutate canonical fields directly   │
│ window.qqpet.load/command/flush + status/projection/result events │
└──────────────────────────────────┬────────────────────────────────┘
                                   │ IPC
┌──────────────────────── Electron main ─────────────────────────────┐
│ PetRepository coordinator                                          │
│  ├─ LocalRepository: embedded shared runtime + local scheduler     │
│  │  + v2 local document (SaveData + engine state + local overlay)  │
│  └─ RemoteRepository: command client + projection cache + token    │
│     + reconnect/resync/idempotency reconciliation                  │
└──────────────────────────────────┬────────────────────────────────┘
                                   │ WSS /v1/sync, JSON frames
┌────────────────────────────── Server ──────────────────────────────┐
│ SessionHub / DeviceAuth / CommandService / RuntimeHost             │
│ Canonical `PetRuntime` (shared deterministic runtime)              │
│ Scheduler + game clock + RNG + scheduled jobs + env inputs         │
│ SQLite WAL: snapshot, commands, events, jobs, devices, settings    │
│ HTTP only: health/readiness; no pet data plane over HTTP           │
└────────────────────────────────────────────────────────────────────┘
```

Host matrix:

| Host | Local mode | Server mode | Authority/transport |
|---|---|---|---|
| Electron desktop | Yes | Yes | Main-process `LocalRepository` or `RemoteRepository`; WSS for server |
| Android | Yes | Hidden/not built | Bridge-hosted `LocalRepository` + local scheduler over shared runtime |
| HarmonyOS | Yes | Hidden/not built | Bridge-hosted `LocalRepository` + local scheduler over shared runtime |
| iOS | Yes | Hidden/not built | Bridge-hosted `LocalRepository` + local scheduler over shared runtime |

All hosts expose the same renderer command/projection contract. Mobile does not get a divergent rule set; it imports the shared runtime and persists the same versioned local document through its native file bridge.

### 4.1 Ownership boundary

- `src/shared/pet-runtime/**` owns game rules, state transitions, deterministic RNG, clock advancement, command validation/execution, and event generation.
- `LocalRepository` in Electron main owns an embedded runtime instance and local persistence/scheduler.
- Server `RuntimeHost` owns the server runtime instance, scheduler, persistence, command ordering, and broadcast.
- Renderer owns only presentation, input, local settings, and command generation.
- Android/Harmony/iOS bridges host `LocalRepository`, the local scheduler, and the local v2 document. They expose the same command/projection/status contract to the shared renderer and hide the server-mode entry point.
- `RemoteRepository` owns transport, reconnect, cursor, and idempotent command status reconciliation. It exists only on desktop in this phase.
- Renderer business code must not branch on `mode === 'server'`.
- Only repository/status/admin UI may know whether storage is local or server.

### 4.2 The one repository abstraction

The repository contract is the only app-facing state boundary. Electron main constructs `LocalRepository` or `RemoteRepository`; Android/Harmony/iOS bridges always construct `LocalRepository`. The renderer receives the same command/projection surface on every host.

```ts
import type { SaveData } from '../save'
import type { PetCommand, CommandResult, SharedSaveData } from './protocol'
import type { DeviceLocalOverlay } from './data-boundary'

export type RepositoryMode = 'local' | 'server'

export interface PetProjection {
  save: SaveData                 // shared projection + local overlay, renderer-ready
  shared: SharedSaveData
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  source: 'local' | 'server' | 'cache'
}

export interface CommandEnvelope {
  opId: string
  command: PetCommand
}

export interface RepositoryStatus {
  mode: RepositoryMode
  connection: 'local' | 'connecting' | 'online' | 'offline' | 'catching_up' | 'error'
  revision: number
  eventSeq: number
  gameTimeMs: number
  advanceWhileEmpty: boolean
  lastError?: string
}

export interface PetRepository {
  load(): Promise<PetProjection>
  execute(envelope: CommandEnvelope): Promise<CommandResult>
  /** Local: persists local document policy. Remote: owner command server.setAdvanceWhileEmpty. */
  setAdvanceWhileEmpty(enabled: boolean): Promise<void>
  flush(): Promise<void>
  status(): RepositoryStatus
  subscribe(listener: (event: RepositoryEvent) => void): () => void
  exportSave(file: string): Promise<void>
  importSave(file: string): Promise<void>
  dispose(): Promise<void>
}

export type RepositoryEvent =
  | { type: 'status'; status: RepositoryStatus }
  | { type: 'projection'; projection: PetProjection; events: OrderedEvent[] }
  | { type: 'commandResult'; result: CommandResult }
  | { type: 'resync'; projection: PetProjection; events: OrderedEvent[] }
```

- Local mode: `execute()` dispatches directly into the embedded runtime command queue and persists atomically.
- Server mode: `execute()` sends a WebSocket command envelope with `opId`; state advances only after server acceptance/projection.
- `load()` reads the local projection cache in both modes. In server mode it may return cached data with `connection: 'connecting'`; no canonical simulation may run until a server projection arrives.
- Import/export are repository operations. Export defaults to the versioned portable bundle (shared SaveData + engine state); a legacy bare-SaveData export may remain compatibility-only. Server-mode import is explicit owner command `admin.importPortableBundle` with server backup; see §7.
- Business code never uses `SavePatch` to mutate canonical state.

## 5. Shared deterministic pet runtime

### 5.1 Required properties

The runtime in `src/shared/pet-runtime/**` must be:

- DOM-free: no `window`, `document`, SWF/Ruffle, Electron, IPC, renderer store, or platform bridge.
- Node/browser-portable: no `node:fs`, `node:path`, or `crypto` inside rule/step functions; seed generation happens in the host.
- Deterministic: given the same `EngineState`, command sequence, tick sequence, clock inputs, environment inputs, and RNG state, it produces exactly the same next state and event sequence.
- Serializable: all state is JSON-safe (no functions, class instances, Map/Set, or promises).
- Pure/step-oriented: command handlers and minute steps do not mutate host state or perform I/O. They return a candidate next state plus ordered events/result; the host commits or discards it.
- Time-injected: no `Date.now()`, `new Date()` without an explicit input, or timers inside rule code.
- RNG-injected: no `Math.random()` or `crypto` inside the runtime.

### 5.2 Runtime state shape

```ts
export const RUNTIME_SCHEMA_VERSION = 1 as const

export interface RngState {
  algorithm: 'xoshiro128**'
  seedHex: string       // 16 bytes, generated by host at pet creation
  stateHex: string      // 16 bytes, current deterministic state
  draws: number         // audit/debug only; must match state evolution
}

export interface ScheduledJob {
  id: number
  type: 'work' | 'study' | 'travel' | 'game-session' | 'daily' | 'other'
  dueAtGameMs: number
  payload: Record<string, unknown>
  status: 'pending' | 'completed' | 'cancelled'
}

export interface CalendarInput {
  date: string
  lunar: string
  term: string | null
  holiday: { name: string; off: boolean } | null
}

export interface WeatherDayRecord {
  /** Game-day key in the pet's timezone; daily boundary at 06:00. */
  dayKey: string
  condition: string
  conditionCode: number
  minC: number
  maxC: number
  /** Current Weather.tomorrowMax equivalent, normalized per game day. */
  tomorrowMax: number
  hours: Array<{ hour: number; code: number; wind: number }>
  provenance: 'live' | 'cache' | 'fallback' | 'imported'
  fetchedAtMs: number
  sourceLabel?: string
}

export interface EnvironmentInputs {
  /** Persisted normalized calendar keyed by game-day key; missing days use deterministic fallback. */
  calendarByDay?: Record<string, CalendarInput>
  /** Persisted normalized weather keyed by game-day key; no singular undated weather record. */
  weatherByDay: Record<string, WeatherDayRecord>
}

export interface GameSessionState {
  sessionToken: string
  deviceId: string
  kind: 'small' | 'flash' | 'diudiule' | 'exam'
  gameId: string
  startedAtGameMs: number
  expiresAtGameMs: number
  status: 'active' | 'settled' | 'abandoned' | 'expired'
  settledCommandSeq?: number
  rewardKey?: string
}

export interface EngineState {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION
  save: SharedSaveData
  gameTimeMs: number
  lastSchedulerWallMs: number
  timeZone: string
  /** Canonical owner weather city; local-only presentation weatherCity is separate. */
  weatherLocation: string
  advanceWhileEmpty: boolean
  rng: RngState
  scheduledJobs: ScheduledJob[]
  nextScheduledJobId: number
  gameSessions: GameSessionState[]
  /** Last daily boundary that actually ran, in the current timezone's day-key form. */
  lastProcessedDayBoundaryKey: string
  /** Next 06:00 boundary in current canonical game time; recomputed on timezone changes. */
  nextDayBoundaryGameMs: number
  environment: EnvironmentInputs
}

export interface RuntimeContext {
  /** Server/local host resolves this before invoking the runtime. */
  gameTimeMs: number
  /** Calendar/weather records already normalized and persisted by the host. */
  environment: EnvironmentInputs
  /** Number of authenticated clients on the server; local running app exposes 1. */
  activeClientCount: number
  /** True only when at least one live client session is present. */
  sessionActive: boolean
}

/** Pure engine output; the host assigns global revision/eventSeq when it commits. */
export interface DomainEvent {
  type: string
  payload: Record<string, unknown>
}

export type RuntimeOutcome =
  | { ok: true; state: EngineState; events: DomainEvent[]; result?: unknown }
  | { ok: false; error: CommandError; events: [] }
```

`SharedSaveData` is the canonical gameplay portion of existing SaveData, defined in §6.

### 5.3 Runtime API

```ts
export function applyCommand(
  state: EngineState,
  command: PetCommand,
  ctx: RuntimeContext,
): RuntimeOutcome

export function advanceMinute(
  state: EngineState,
  ctx: RuntimeContext,
): RuntimeOutcome
```

- `applyCommand` validates all preconditions first, then computes a candidate state. A rejected command returns no state change, no RNG consumption, and no events.
- `advanceMinute` advances exactly one game minute and returns the next candidate state/events.
- Host code assigns `revision`/`eventSeq`/`commandSeq`, wraps `DomainEvent` in `OrderedEvent`, persists the accepted candidate atomically, and broadcasts the resulting projection. A transaction failure must discard the candidate; RNG/time cannot advance without durable state.
- `Math.random` and direct wall-clock reads are forbidden in runtime modules and enforced by lint/test checks.

### 5.4 RNG semantics

- Use `xoshiro128**` seeded with 128 bits from the host's CSPRNG at pet creation or legacy migration when no engine state exists. Portable imports preserve the bundle's existing seed/current state. Persist both seed and state.
- Provide `randomUnit()`, `randIntInclusive(min,max)` using the same rounded distribution as the current `rand()` helper (`src/renderer/pet/rand.ts:2`), `shuffle()`, `loot()`, and any other random helper used by game rules.
- Every state transition consumes RNG only through the runtime's Rng object. The state evolution is persisted with the canonical snapshot.
- Random decisions that affect canonical state include: minute decay/illness, task generation/rewards, loot, travel destination/encounters, fishing outcomes, island fights/errands, game session rewards, mail contents, and farm disasters. They must not use client RNG.
- Client-only random choices for animation variants, idle speech, AI phrasing, or SWF visuals remain presentation randomness and never affect canonical state.
- Rejected commands consume no RNG. If a handler validates and then encounters an internal error, the host discards the whole candidate state including RNG and returns a controlled error.

### 5.5 Tick order and clock semantics

One canonical game minute is exactly 60,000ms of **game time**. Wall time is only a host scheduling input.

For each `advanceMinute`:

1. Increment canonical `gameTimeMs` by 60,000.
2. Determine daily-boundary transitions in the persisted IANA `timeZone`; at the 06:00 boundary run deterministic daily transitions: task reset/roll, sign-in day reset, fish daily limits, mail due, VIP/expiry day handling, timed-good expiry/rollover.
3. Process all scheduled jobs due at or before the new `gameTimeMs`, ordered by `(dueAtGameMs, jobId)` ascending. A due job is completed/cancelled exactly once; its reward/event is emitted at this point.
4. Apply passive game-world effects: mood/hunger/clean decay, timed-good remaining time, growth contribution, task counters, and level/cap recomputation. Accrue `onLineTime`, `onlineDataTime`, and the sign-in online-gift countdown only when `ctx.sessionActive`/`ctx.activeClientCount > 0`; never accrue those session rewards for empty world-time catch-up.
5. Run deterministic random event checks (illness, health loss, daily random content, weather-related strain) using the runtime RNG.
6. Schedule any next jobs, daily boundaries, or delayed events.
7. Emit ordered domain events for meaningful changes.

The runtime must keep the legacy SaveData projections coherent: set `nowTimeLine` to `floor(gameTimeMs / 1000)`, reflect active jobs in `activeOption`, and reflect remaining job progress in `saveJsonData.activity` where existing consumers expect them. Scheduled jobs remain authoritative; those SaveData fields are compatibility projections for export/UI, not a second timer source.

The order is normative because it affects RNG and reward outcomes. Characterization tests must lock it before extraction is considered complete.

Shared `settings.paused` semantics: while paused, the canonical game clock may continue advancing, but pet aging, passive decay/growth, scheduled job completion, random pet events, and daily pet transitions are suspended. Pending deadlines are held in pet-active time or shifted by the paused interval so they cannot fire while paused, and unpausing does not backfill the paused interval. This is separate from `advanceWhileEmpty`, which controls time when zero clients are connected.

#### Timezone and daily-boundary rules

- `lastProcessedDayBoundaryKey` is the canonical key (`YYYY-MM-DD` of the 06:00 boundary in the current pet timezone) of the last daily boundary that actually ran.
- `nextDayBoundaryGameMs` is the next 06:00 boundary strictly after the current `gameTimeMs` in the current IANA timezone.
- During ordinary advancement/catch-up, boundaries are processed in chronological order and each key runs exactly once. When a boundary runs, update `lastProcessedDayBoundaryKey` and recompute `nextDayBoundaryGameMs` from the current zone/game time before continuing.
- `server.setTimeZone` is owner-only. It persists the new IANA zone, then:
  1. Computes the current game-day key in the new zone at current gameTime and sets `lastProcessedDayBoundaryKey` to it without running that already-passed boundary;
  2. Computes the next 06:00 boundary strictly after current gameTime and sets `nextDayBoundaryGameMs` to it;
  3. Replaces old pending daily-boundary jobs with exactly one job for that next boundary;
  4. Does not immediately reset daily counters, sign-in state, fish daily limits, mail, or VIP state. Those run at the next boundary exactly once.
- DST transitions use IANA calendar arithmetic; a missing local 06:00 is resolved to the next valid instant, and a repeated local time must not produce a duplicate boundary key.
- Tests must cover eastward and westward timezone changes, DST spring-forward/fall-back, changing the zone after a boundary already passed, repeated timezone changes, and no duplicate daily/sign-in rewards.

Game-clock vs session-clock:

- **Game-clock effects:** hunger/clean/mood decay, growth, tasks, jobs/travel, illness, random events, death, daily resets, farm/fishing growth, and other canonical world state. These advance whenever the scheduler advances game time, including enabled empty intervals.
- **Session-clock effects:** `onLineTime`, `onlineDataTime`, and the sign-in online-gift countdown. These accrue only while `sessionActive=true` (at least one authenticated client in server mode, or the local app actively running). They do not accrue during `advanceWhileEmpty=true` catch-up with zero clients, and they do not accrue during local closed-app fast-forward.
- `advanceWhileEmpty=true` therefore makes the pet world older while nobody is online, but not the owner's “online time” or online gift timers.

### 5.6 `advanceWhileEmpty` and scheduler semantics

`advanceWhileEmpty` is a persisted per-pet policy. On the server it controls whether game time advances when **zero authenticated clients are connected**; local mode applies the same policy to app-closed/suspended intervals (§8.2).

- **Enabled (`true`)**: the server keeps a live scheduler and advances game time continuously with zero clients. On server restart or process downtime, it catches up from the persisted scheduler anchor to wall-clock now. A later reconnect sees the advanced world state. Empty intervals advance game-clock effects only, not session-clock online-time/sign-in gift effects.
- **Disabled (`false`)**: when the last authenticated client disconnects, game time freezes at the current boundary. Scheduled deadlines and active jobs remain pending in game time and do not complete while frozen. On reconnect, the server resumes from the current game time and does **not** backfill the empty interval; the next game minute occurs after 60s of active scheduler time. This also applies after server restart, because a restarted server has zero clients.
- The setting is stored with the pet and visible in storage status. Server changes use owner command `server.setAdvanceWhileEmpty`; local changes use the unified `setAdvanceWhileEmpty` repository capability. Changing false→true while a client/app is active enables future empty periods; it does not retroactively backfill an interval that already happened while false. Changing true→false takes effect when the last client leaves (or when the local app closes).
- Default for MVP: `true`, preserving the current product expectation that offline task/progress time counts. The human may change the default before implementation approval; the semantics above stay the same.

Scheduler cadence:

- Scheduler poll interval: 1,000ms wall time.
- Game tick interval: 60,000ms game time.
- A live server processes each due whole minute; it never runs a partial-minute tick.
- `lastSchedulerWallMs` is persisted transactionally with `gameTimeMs`. If enabled and the process was down, `due = floor((wallNow - lastSchedulerWallMs)/60_000)`.
- If disabled and zero clients, the server writes `lastSchedulerWallMs = wallNow` and does not advance game state. On resume it resets this anchor to wall now, so the empty gap is discarded.
- If disabled while at least one client is connected, it advances using active wall time and catches up only interruptions that occur while a client remains connected.
- During a long enabled catch-up, clients may connect but commands are rejected with `server_catching_up` until the catch-up target is reached; the client receives `catchingUp: true` and a final snapshot. This prevents user commands from interleaving with historical ticks.

### 5.7 Bounded catch-up, restart recovery, and zero-client behavior

- `CATCHUP_CHUNK_TICKS = 1440` (one game day) by default.
- Catch-up runs at most one chunk per event-loop turn, persists a SQLite transaction, yields, then continues. It must not block the process in an unbounded `for` loop.
- The target wall time is fixed at the start of a catch-up run. After reaching it, the server starts live scheduling and accounts for any later elapsed time normally.
- With `advanceWhileEmpty=true`, server downtime is caught up on startup. With `false`, no catch-up is performed across a start with zero clients.
- A crash before a transaction commits loses that chunk; the persisted anchor/game time remains the previous committed state, so recovery is idempotent. A crash after commit but before broadcast is recovered by snapshot/replay; no game step is applied twice.
- The scheduler and command executor share one serialized per-pet queue. A command arriving during a tick batch waits until the batch commits; commands and ticks have a single total order.
- At startup the server reads canonical state, RNG state, jobs, and scheduler anchor, validates them, and fails closed if they are inconsistent or corrupt.
- Health reports `ready`, `catchingUp`, `gameTimeMs`, `wallLagMs`, `nextTickAtMs`, `scheduledJobs`, and `revision`.

### 5.8 Calendar, weather, AI, and other external inputs

- Runtime rules do not call network services. Calendar/weather inputs are fetched by the host, normalized, persisted, and injected.
- Canonical weather is stored as `EnvironmentInputs.weatherByDay`, keyed by the pet's game-day key. There is no singular undated weather value.
- The game-day key is `YYYY-MM-DD` for the local date of the 06:00 game-day boundary in the canonical pet IANA timezone. All days crossing in the same timezone use the same key convention.
- Each `WeatherDayRecord` includes: day key, condition (human-readable and code), min/max temperatures, `tomorrowMax`, hourly forecast entries, provenance (`live`, `cache`, `fallback`, or `imported`), fetch time, and optional source label.
- Server mode uses an owner/operator-configured canonical weather city persisted in `pet_settings.weather_location`. It is configured by `server init --weather-city`, `QQPET_SYNC_WEATHER_LOCATION`, or the owner command `server.setWeatherCity`. The client-local `settings.weatherCity` is presentation-only and never becomes canonical input.
- The server fetches and caches forecasts outside the pure runtime, normalizes them, and persists each day's record before the tick/command that consumes it. It records provenance so a replayed/caught-up day is reproducible.
- For a game day with no live/cached forecast, the host injects a deterministic seeded fallback derived from the persisted RNG `seedHex` plus the day key. Fallback generation must be stable independent of how many other RNG draws occurred; it must not consume the mutable game RNG stream.
- Do not retroactively inject today's live weather into historical ticks. A day's weather record, once persisted, is the canonical input for that day.
- AI-generated text is presentation output, not canonical state. Existing `saveJsonData` values that contain AI prose (island/news/community narration) must be split into:
  - canonical IDs, counters, flags, and outcomes owned by the server; and
  - device-local presentation caches/prose that may be regenerated or discarded.
- If a feature cannot be separated from client-generated prose without changing behavior, that is an explicit migration risk requiring a decision before that feature is enabled in server mode. It must not become a hidden client-side rule path.

### 5.9 Runtime extraction map

Move to `src/shared/pet-runtime/**`:

- `pet.ts` pure tick/health/death/level/cap logic, minus DOM/SWF/speech.
- `store.ts` pure stat/luck/fatigue/growth selectors and shared stat mutations.
- `items.ts`, `goods.ts`, `loot.ts`, `level.ts`, `activity.ts`, `jobs.ts`.
- `tasks.ts`, `signin.ts` (including online-gift countdown), `mail.ts`, `vip.ts`, `album.ts` outcome logic.
- Online-session counters from `pet.ts` and session-active gating; per-day weather/day-key/fallback normalization from `weather.ts`.
- `fishing.ts` pond/wallet/schedule rules.
- Game-content data needed by server rules (`goods.json`, `ills.ts`, `travel.json`, `pool.json`, `exam.json`, `fries.json`, `album.json`, and related static tables) must be importable from a DOM-free shared content module; renderer presentation may reuse the same data.
- Farm gameplay rules currently encoded in `ui/farm.ts` and `Farm.swf`; the part that determines coins, crops, pests, harvests, and persistence must be reimplemented as runtime reducers with compatibility tests.
- Island/social canonical decisions (errand selection, item consumption, fight RNG/outcomes, counters, rewards) and community game/task progress.
- Game/session reward rules currently in `ui/games.ts`, `ui/smallgame.ts`, `ui/diudiule.ts`.
- Save-schema validation, command validation, deterministic event emission, and daily/timer scheduling.

Keep in the renderer (presentation only):

- `SwfPlayer`, Ruffle, `Machine`, animations, speech bubbles/AI phrasing, focus/keyboard, window geometry, tray state, cursor behavior, and local UI.
- Command buttons that construct semantic commands and display pending/accepted/rejected states.
- Local-only settings, position, and visual/narration caches.

## 6. Shared, device-local, and never-upload data

### 6.1 Canonical shared state

`SharedSaveData` is the server-owned gameplay document. It is the existing SaveData shape with device-only fields removed and shared settings reduced to an explicit allowlist.

```ts
import type { SaveData, PetInfo, Settings } from '../save'

export const SHARED_SETTINGS_KEYS = ['paused', 'difficulty', 'undying'] as const
export type SharedSettings = Pick<Settings, (typeof SHARED_SETTINGS_KEYS)[number]>
export type SharedPetInfo = Omit<PetInfo, 'lastX' | 'lastY'>

export interface SharedSaveData extends Omit<SaveData, 'petInfo' | 'settings'> {
  petInfo: SharedPetInfo
  settings: SharedSettings
}

export interface DeviceLocalOverlay {
  petInfo: Pick<PetInfo, 'lastX' | 'lastY'>
  settings: Omit<Settings, keyof SharedSettings>
  /** Local-only presentation caches, e.g. community position, not canonical. */
  presentation?: Record<string, unknown>
}
```

Shared settings for MVP:

- `paused` — pet growth is paused for the pet, not just one window.
- `difficulty` — economy/gameplay difficulty shared by the pet.
- `undying` — shared survival rule.

All other settings are device-local. `chatCheat`/`cheatTab` remain local UI gate flags; actual cheat mutations go through owner commands. If a local flag permits a command, the server still validates the command and authorization.

`saveJsonData` requires an explicit feature split, not a blind whole-blob upload:

- **Shared/canonical gameplay blobs:** `email`, `task`, `signin`, `fishs`, `farm`, `activity`, canonical album/collection state, and the decision/counter/flag subset of `island`.
- **Local presentation-only caches:** community walk position, generated island/community prose/news, weather-line “already shown today” markers, and other values that do not affect a canonical decision or reward.
- **Rule:** if a value changes a reward, RNG roll, timer, inventory, task, or pet stat, it belongs in SharedSaveData and can only change through a server/local runtime command or tick. Presentation-only values may live in the device overlay.
- Server-side validation enforces a per-blob allowlist inside `saveJsonData`; local-only blobs and unknown blob keys are rejected from SharedSaveData and from admin imports.

`saveNum` remains in the legacy SaveData shape for migration compatibility, but it is never used as a server revision, CAS token, or idempotency key. The server's `revision` is independent.



### 6.2 Device-local fields and never-upload values

Device-local overlay:

- `petInfo.lastX`, `petInfo.lastY` — window position, never a command and never broadcast.
- `settings.opacity`, `music`, `sound`, `faceClick`, `quiet`, `autoStart`, `hidden`, `hd`, `zoom`, `windowDirection`, `clip`, `watchApp`, `roam`, `lan`, `webhook`, `webhookPort`, `webhookToken`, `voice`, `memory`, `polish`, `search`, `searchBackend`, `searchKey`, `petBar`, `chatCheat`, `cheatTab`, `weatherCity`, `autoUpdate`, `updateCheckedAt`, `petDisplayId`, `aiUrl`, `aiKey`, `aiModel`.
- Local presentation caches that do not affect canonical game rules, such as community walk position and generated narration/prose.

Never upload:

- `aiKey`, `searchKey`, `webhookToken`.
- Server token/pairing credentials.
- TLS private keys and any local credential material.
- Raw filesystem paths or machine identifiers unless explicitly redacted from diagnostics.
- Device position, zoom, display ID, window visibility, or other UI state.

No full settings object is uploaded to the server. The server rejects any command/projection payload containing local-only fields; client filtering is only a defense-in-depth convenience.

### 6.3 Projection hydration and aliases

- Server and local snapshots contain `SharedSaveData`; main applies the current device overlay before exposing `SaveData` to the renderer.
- Merge canonical object groups into the existing `save.petInfo` and `save.settings` objects in place; never replace those object references.
- Replace arrays/scalars using the same shape semantics the UI expects.
- Preserve local fields and local presentation caches.
- After applying a projection, notify info/settings listeners and invalidate/reload cached game views.
- A projection update carries `revision`, `eventSeq`, `gameTimeMs`, `timeZone`, and `advanceWhileEmpty`. The renderer must apply projections in order and stop on a gap; it must not apply a later snapshot speculatively.

### 6.4 Feature-cache invalidation

On a full projection or relevant event, invalidate/reload:

- `src/renderer/pet/tasks.ts` progress cache.
- `src/renderer/pet/signin.ts` sign-in cache.
- `src/renderer/pet/fishing.ts` pond cache.
- `src/renderer/ui/island.ts` island state.
- `src/renderer/ui/farm.ts` canonical farm cache and Ruffle localStorage scratch; close/reload the farm panel on a remote farm projection rather than overwriting it from stale local SWF state.
- Any future module that parses `saveJsonData` at module load.

Open panels should re-render from the new projection or show a generic “state changed; reopen” notice. They must not write a stale parsed blob back into SaveData.

### 6.5 Portable bundle, local document v2, and migration path

All authoritative engine state moves between local and server mode only through a versioned portable wrapper. This prevents a local→server upload or server→local detach from losing RNG, schedules, active sessions, environment cache, or scheduler anchors.

```ts
interface PortablePetBundleV1 {
  format: 'qqpet-portable-v1'
  schemaVersion: 1
  exportedAtWallMs: number
  sourceRevision: number
  sourceEventSeq: number
  shared: SharedSaveData
  engine: EngineState
}
```

`EngineState` must include: game time, scheduler anchor, RNG seed/state, scheduled jobs/deadlines, active game/exam/session records, timezone, canonical weather location, `advanceWhileEmpty`, last-processed day-boundary key, next day-boundary time, and the per-day environment cache. Device-local settings, position, credentials, AI/search/webhook secrets, and local prose are not included. Active session tokens are opaque and device-bound; after import/detach they remain usable only by the matching originating device, otherwise they are marked abandoned/expired and cannot be rewarded. Exported bundles must be treated as sensitive pet data and never logged in full.

```ts
interface LocalPetDocumentV2 {
  format: 'qqpet-local-v2'
  schemaVersion: 1
  revision: number
  eventSeq: number
  bundle: PortablePetBundleV1
  device: DeviceLocalOverlay
}
```

Server-mode cache uses the same `save.json` path but a distinct versioned shape, with no local engine authority:

```ts
interface RemoteProjectionCacheV2 {
  format: 'qqpet-server-projection-v2'
  schemaVersion: 1
  petId: string
  deviceId: string
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  shared: SharedSaveData
  device: DeviceLocalOverlay
}
```

- Local-mode v2 and remote cache are separate formats; mode switches write the appropriate one and back up the old one.
- Old bare `SaveData` and original `config.json` imports are normalized into a portable bundle through the migration adapter: preserve shared data where possible, seed deterministic new RNG when absent, reconstruct job/session/day-boundary state, and back up the original file.
- Local full closed-app progression: with local `advanceWhileEmpty=true` (default), the next launch runs the full shared runtime from the persisted scheduler anchor through the entire closed interval in bounded catch-up chunks. This advances hunger, growth, illness, random events, death, tasks, jobs, farm/fishing and other game-world effects, not merely task completion. This is an approved deliberate behavior change. Online-session counters/sign-in online-gift countdown do not accrue for the closed interval (`sessionActive=false`). A one-time migration/UX warning and catch-up progress status are required; commands remain unavailable until catch-up completes.
- With local `advanceWhileEmpty=false`, the next launch resets the scheduler anchor to now and does not backfill the closed interval; pending jobs remain pending and resume relative to game time.
- Import anchor clamp and no double catch-up:
  - On local→server upload or server→local detach, preserve the bundle's `engine.lastSchedulerWallMs` unless it is outside the import bounds.
  - `anchor = clamp(imported.lastSchedulerWallMs, wallNow - MAX_IMPORT_ANCHOR_PAST_MS (48h), wallNow + MAX_IMPORT_FUTURE_SKEW_MS (5m))`.
  - Preserve `engine.gameTimeMs` as the authoritative game time; do not replay the command/event log and do not run a separate import catch-up.
  - If the clamped anchor is in the future, use `wallNow` as the effective scheduler start (preserve game time, no negative/zero-delay catch-up) and record `importClamped=true`.
  - If the destination has `advanceWhileEmpty=true`, startup catch-up runs exactly once from the effective anchor to wall now, subject to the normal bounded scheduler. If the anchor was clamped, record `importClamped=true` in status/logs; interval beyond the bound is not replayed.
  - If `advanceWhileEmpty=false`, set the scheduler anchor to wall now after import and do not backfill.
  - If `allowClamp=false`, reject an out-of-bounds anchor; if `true`, clamp and report `importClamped`. Tests must cover future anchors, anchors older than 48h, exact-boundary imports, and repeated import/restart without double catch-up.
- Export produces a portable bundle by default; import accepts a portable bundle or migrates a legacy bare SaveData/config.json into one. The import UI must explicitly show whether engine state/RNG/schedule is preserved and must back up the destination before replacing.
- No local save becomes canonical in server mode. The server-mode `save.json` is a read-only projection cache with local overlay, not a source of authority.

### 6.6 Temporary coexistence rule

The current renderer has many direct mutation call sites. Full migration is large. Temporary coexistence is allowed only during implementation, with these constraints:

- The old renderer mutation path and the new command/runtime path must never both mutate gameplay state in the same running mode.
- Each migration group is switched atomically behind a developer feature flag; outside the test/dev flag, there is exactly one writer.
- Server mode is not exposed to users until every gameplay mutation group has a corresponding semantic command/runtime handler.
- The final local-runtime commit switches desktop and mobile local mode to the shared runtime by default and removes/guards direct gameplay `update()`/`save(patch)` use on every host.
- No compatibility adapter may forward a client-produced SavePatch to the server. Any temporary local adapter is deleted before release.

## 7. Command model and command catalog

### 7.1 Command semantics

- A command is a **semantic intent**, not a state delta. Clients do not send `SavePatch`, absolute stats, inventory arrays, task blobs, or reward amounts.
- The server validates the command against the current canonical state and executes the corresponding runtime handler. LocalRepository uses the same handler in process.
- Commands apply in strict server order. There is no client `baseRevision` merge and no client-side rebase.
- A stale UI can produce a valid command or a semantic rejection. If the item is gone, task is already claimed, pet is busy, etc., the result is `rejected`; the client receives/request a current projection and refreshes. No command is silently retried with a new interpretation.
- A command that starts a timed activity schedules a server job/deadline; the client does not run an authoritative interval.
- All handlers are deterministic given state, command, game time/environment inputs, session context (`activeClientCount`/`sessionActive`), and RNG state.
- Authorization is role-based:
  - `player`: may submit normal gameplay commands.
  - `owner`: may submit gameplay, admin, import, server-setting, and pairing/device-management commands.
  - Destructive/admin commands require owner authority: `pet.reset`, `pet.adopt`, `admin.importPortableBundle`, `admin.grantCheat`, `admin.grantRandomGoods`, `server.setTimeZone`, `server.setAdvanceWhileEmpty`, `server.setWeatherCity`, and device revocation/import operations.
- Every accepted command is atomic: canonical snapshot, engine state/RNG, scheduled jobs, command-log row, event-log rows, revision/command/event sequence, and projection all reflect the same commit.

### 7.2 Command envelope, results, and errors

```ts
import type { Sex } from '../save'

export type CommandRole = 'player' | 'owner'

export interface CommandError {
  code:
    | 'invalid_payload'
    | 'no_pet'
    | 'pet_dead'
    | 'paused'
    | 'busy'
    | 'insufficient_funds'
    | 'insufficient_item'
    | 'not_available'
    | 'wrong_phase'
    | 'already_claimed'
    | 'cooldown'
    | 'unauthorized'
    | 'offline'
    | 'server_catching_up'
    | 'internal'
  message: string
  refreshProjection: boolean
}

export type CommandResult =
  | {
      status: 'applied'
      opId: string
      commandSeq: number
      revision: number
      eventSeq: number
      result?: Record<string, unknown>
    }
  | {
      status: 'rejected'
      opId: string
      commandSeq: number
      revision: number
      eventSeq: number
      error: CommandError
    }
  | {
      status: 'duplicate'
      opId: string
      commandSeq: number
      revision: number
      eventSeq: number
      original: 'applied' | 'rejected'
      result?: Record<string, unknown>
      error?: CommandError
    }
```

- `opId` is generated once by main-process repository code for a user intent and is scoped to the authenticated `(petId, deviceId)`.
- The command log is the idempotency record. A duplicate `opId` from the same device returns the stored result and never executes the handler, consumes RNG, or emits new events. A different device reusing the same string is a separate command, not a way to read another device's result.
- Rejections are also stored/logged for idempotency and `commandStatus`.
- Rejected commands do not increment canonical revision (but may receive a command-log sequence).
- `refreshProjection: true` instructs the client to request/accept the latest projection before offering a retry.
- No client-side `SavePatch` is permitted for canonical state in either mode.

### 7.3 In-flight command and disconnect semantics

There is no offline command queue and no optimistic canonical write.

- `RemoteRepository` allows at most one in-flight gameplay command per connection.
- While online, the command is sent with `opId`. The renderer may show a pending indicator but must not apply the command's effect to canonical state.
- If the socket closes before a result:
  1. The repository marks the command `unconfirmed`.
  2. On reconnect, it sends `commandStatus {opId}` rather than blindly resending the command.
  3. If the server has an applied/rejected record, the client receives that result; an applied record is followed by the current projection.
  4. If the server has no record, it returns `not_applied`. The command was never committed. The repository does not resend it, discards the pending record only after hydrating the latest projection, and unlocks the UI.
  5. While status is unresolved, the UI is frozen/read-only and offers no new command. After `not_applied`, it offers an explicit retry with a fresh `opId`; no automatic retry occurs.
- A small local `pending-command.json` may persist one opId/hash for this reconciliation; it is not a queue and never auto-executes offline.
- Commands submitted while offline are rejected locally with `offline`; they are not queued.
- If the server applied the command but every response was lost, `commandStatus` returns applied and the next snapshot proves the canonical effect. It is not executed twice.
- The server must retain command results at least as long as the MVP's pending-reconciliation window (30 days or 10,000 commands, whichever is greater), independent of backups.

### 7.4 Timed activities and scheduled commands

Commands that take game time create `ScheduledJob` records and return immediately:

- `job.startWork`, `job.startStudy`, `job.startTravel`.
- `game.startSession`/`diudiule.startSession` create one-use server game session records and return a server-issued session token. `game.reward`/`diudiule.reward` settle a token exactly once; server time/duration caps and runtime RNG determine the reward, never a client amount.
- `exam.start` creates a server exam session and returns deterministic questions/options; `exam.submit` validates answers and advances study state.
- Mail, daily resets, fish growth/speed-up windows, farm disasters/crops, VIP expiry, and task refresh are engine timers/jobs.
- Completion happens only in `advanceMinute` when the game clock reaches the deadline. The client may display a countdown from `gameTimeMs`, but cannot complete the activity itself.
- Game, diudiule, and exam sessions are server-side, one-use records. Rewards/submissions settle once; duplicates return the stored command result. A reward token from another device, an expired token, an already-settled token, or a token outside its cap is rejected. Abandoned/expired sessions are cancelled without reward unless explicitly settled before deadline; they never remain client-authoritative.
- Default session timeouts in game time: small/flash game 60 minutes, diudiule 5 minutes, exam 30 minutes. Expiry is processed by the runtime scheduler; a token cannot be rewarded after expiry. A client disconnect does not automatically settle a session; the same device may settle before its game-time deadline, otherwise the session is cancelled without reward. If the world is frozen (`advanceWhileEmpty=false`, zero clients), expiry does not run until time resumes.
- `game.reward` integrates task counters exactly once: `GameRound += 1`, `Game += capped played minutes` (daily cap 60 minutes, current `ui/games.ts` behavior). `diudiule.reward` mirrors current `ui/diudiule.ts`: mood/yb reward with server caps, and no `GameRound`/`Game` counter increment. Future changes to this parity require a command/schema migration.
- Exploit tests must cover fabricated tokens, token replay, token from another device, expired/abandoned sessions, duplicate reward commands, arbitrary client reward amounts, time acceleration, and attempts to settle an exam/game token through the wrong command.
- When the server is frozen (`advanceWhileEmpty=false`, zero clients), deadlines remain frozen in game time; they resume when a client connects. They do not complete due to wall-clock passage during the empty period.

### 7.5 Command catalog

The catalog is normative for migration coverage. A feature is not complete for server mode until every canonical SaveData mutation in its group has a command/handler; the “Current mutation source” column identifies the existing call sites to characterize. Feature parity is mandatory: farm, fishing, island, small games, mail, sign-in, jobs, travel, and shop/inventory must not be hidden in server mode. If a discovered canonical mutation lacks a command, add the semantic command/event and its migration group before implementation proceeds.

#### Group A — Lifecycle, core stats, timers and direct pet interaction

| Command | Payload | Current mutation source | Runtime behavior |
|---|---|---|---|
| `pet.adopt` | `{ sex: 'GG' or 'MM' }` | `src/renderer/ui/adopt.ts:27-28` | Owner-only. Create newborn canonical state, set `havePet`, initial stats/birthday, first growth event. Handles both-sides-empty bootstrap. |
| `pet.reset` | `{}` | `src/main/save.ts:86-89`; `readopt` at `src/renderer/ui/menu.ts:49-51` | Owner-only. Result is canonical empty egg-selection state: `havePet:false`, pet-specific gameplay/inventory/tasks/jobs/sessions cleared, shared settings preserved, schedules/RNG/day-boundary state rebuilt atomically. Then `pet.adopt` creates the pet. |
| `pet.bury` | `{}` | `src/renderer/pet/pet.ts:286-292`; `src/renderer/ui/menu.ts:86` | Set burial state and emit death/burial events. |
| `pet.rename` | `{ name?: string; host?: string }` | `src/renderer/ui/petinfo.ts:41-49` | Validate length/characters; update canonical names. |
| `pet.setPaused` | `{ paused: boolean }` | `src/renderer/pet/store.ts:185-188`; `src/renderer/ui/menu.ts:66-69` | Shared `settings.paused`; stops/resumes growth clock at server; no client timer. |
| `pet.pokeFace` | `{ spotId: string }` | `src/renderer/ui/face.ts:17-24` | Count `ddw`/`Amusing`, RNG mood gain, task counter, cooldown/validation; emit animation event. |
| `pet.cheer` | `{}` | `src/renderer/pet/pet.ts:65-70` | Optional chat/small-talk mood cheer if product keeps the current behavior; otherwise presentation-only. |

The minute tick itself is not a client command. The server scheduler calls `advanceMinute` for passive stats, online time, level/cap updates, illness, health loss, and death/revival state.

#### Group B — Inventory, wallet, goods and VIP economy

| Command | Payload | Current mutation source | Runtime behavior |
|---|---|---|---|
| `inventory.buy` | `{ type: GoodType; itemId: string; quantity: number }` | `src/renderer/pet/items.ts:155-168`; shop UI | Validate level/PD/price/stock; deduct yb; add inventory/illustrated; emit purchase event. |
| `inventory.use` | `{ type: GoodType; itemId: string; quantity?: number }` | `src/renderer/pet/items.ts:68-107`; control/shop use buttons | Validate ownership/pet state; apply stats, timed-good clock, task counters, achievements, effects; result determines presentation action. |
| `medical.treat` | `{ mode: 'doctor' or 'owned'; itemId?: string }` | `src/renderer/pet/items.ts:109-200` | Server diagnoses/charges/uses correct medicine or owned item; handles revive/death; client cannot choose arbitrary cure outcome. |
| `vip.buyPinkDiamond` | `{ days: number }` | `src/renderer/pet/vip.ts:37-52`; `src/renderer/ui/state.ts:87-100` | Deduct 300/day, extend/activate, reset fish daily limits. |
| `vip.clearPinkDiamond` | `{}` | `src/renderer/pet/vip.ts:30-35` | Clear membership and re-settle. |
| `vip.buySweetheart` | `{ days: number }` | `src/renderer/pet/vip.ts:54-58`; `src/renderer/ui/state.ts:60-73` | Deduct price, extend/activate sweetheart. |
| `vip.setSweetheart` | `{ enabled: boolean }` | `src/renderer/ui/state.ts:74-84` | Toggle shared sweetheart mode after membership validation. |
| `travel.completeCollection` | `{}` | `src/renderer/ui/travel.ts:28-39` | Charge 8888, increment travel completion, reset visited list/task state in one atomic command. |

#### Group C — Jobs, study, travel, exams and tasks

| Command | Payload | Current mutation source | Runtime behavior |
|---|---|---|---|
| `job.startWork` | `{ jobId: string }` | `src/renderer/pet/jobs.ts:86-110`; `src/renderer/pet/activity.ts:19-24` | Validate eligibility, set active work, schedule work completion at game minute deadline. |
| `job.startStudy` | `{ courseId: string }` | `src/renderer/pet/jobs.ts:136-164` | Validate lessons, schedule study completion; early-finish RNG is server RNG. |
| `job.startTravel` | `{}` | `src/renderer/pet/jobs.ts:197-209` | Server RNG chooses destination, schedules travel deadline; no client city choice unless product adds one. |
| `activity.stop` | `{}` | `src/renderer/ui/state.ts:56`; `src/renderer/pet/activity.ts:27-35` | Cancel current work/study/travel job and emit result. |
| `task.claim` | `{ tab: TaskTab; index: number }` | `src/renderer/pet/tasks.ts:149-156`; `src/renderer/ui/task.ts:24-28` | Validate completion/not claimed, mark claimed, grant deterministic rewards. |
| `exam.start` | `{ subject: string }` | `src/renderer/ui/exam.ts:18-45` | Server RNG chooses questions/options, persists exam session, returns question IDs; client renders. |
| `exam.submit` | `{ examId: string; answers: number[] }` | `src/renderer/ui/exam.ts:40-44` | Validate/grade against persisted session, update studyInfo/course level, emit event. |

Scheduled engine jobs include task refresh/daily rolls, work/study/travel completion, and any exam-ready event. None is completed by a client timer.

#### Group D — Daily resets, sign-in, mail, VIP timers

Automatic engine transitions (no client command):

- 06:00 daily task roll/reset — `src/renderer/pet/tasks.ts:160-169`, `223-241`.
- Sign-in daily reset — `src/renderer/pet/signin.ts:108-113`.
- Fish daily speed-ups — `src/renderer/pet/fishing.ts:222-226`.
- VIP day settlement/expiry — `src/renderer/pet/vip.ts:16-69`.
- Mail delivery/due checks — `src/renderer/pet/mail.ts:58-72`.
- Timed-good countdown/expiry — `src/renderer/pet/goods.ts:61-71`.

User commands:

| Command | Payload | Current mutation source | Runtime behavior |
|---|---|---|---|
| `signin.sign` | `{}` | `src/renderer/pet/signin.ts:49-57` | Validate day/not signed; update collection; grant server-RNG reward. |
| `signin.drawGrowth` | `{}` | `src/renderer/pet/signin.ts:63-75` | Validate draw availability; server RNG produces digits/reward. |
| `signin.claimOnlineGift` | `{}` | `src/renderer/pet/signin.ts:81-89`; `src/renderer/ui/signin.ts:155-172` | Validate countdown/cost; server deducts yb and grants deterministic reward. |
| `signin.claimBirthdayGift` | `{}` | `src/renderer/pet/signin.ts:98-105` | Validate birth date/not claimed; grant server-RNG food. |
| `mail.claim` | `{ mailId: string }` | `src/renderer/ui/email.ts:24-32` | Validate unread/live mail, mark claimed, grant mail goods. |
| `mail.claimAll` | `{}` | `src/renderer/ui/email.ts:24-32` | Claim all eligible mail atomically, with one result and event batch. |
| `mail.delete` | `{ mailId: string }` | `src/renderer/ui/email.ts:24-32,64` | Validate claimed mail; mark deleted/empty exactly once. |
| `mail.deleteAll` | `{ scope: 'claimed' }` | `src/renderer/ui/email.ts:24-32,83` | Delete all currently claimed mail atomically; unclaimed mail is not removed by this command. |

#### Group E — Games, social/world, album and island

| Command | Payload | Current mutation source | Runtime behavior |
|---|---|---|---|
| `game.startSession` | `{ gameId: string; kind: 'small' or 'flash' }` | `src/renderer/ui/games.ts:17-28`; `src/renderer/ui/smallgame.ts:87-101` | Validate pet can play; create server game session, return a server-issued `sessionToken`, start game time, and presentation seed; no reward yet. |
| `game.reward` | `{ sessionToken: string }` | `src/renderer/ui/games.ts:17-28`; `src/renderer/ui/smallgame.ts:87-101` | Validate token/device/kind/expiry; compute server-duration-capped yb/growth/mood and RNG rewards; increment `GameRound` once and capped `Game` minutes; settle once. |
| `diudiule.startSession` | `{}` | `src/renderer/ui/diudiule.ts:31-38` | Validate playable state; create one-use diudiule session/token. |
| `diudiule.reward` | `{ sessionToken: string }` | `src/renderer/ui/diudiule.ts:31-38` | Validate token/device/expiry; apply current diudiule mood/yb reward with server caps; settle once. Current behavior does not increment `GameRound`/`Game`; record that explicitly. |
| `game.abandonSession` | `{ sessionToken: string }` | Session lifecycle | Originating device (or owner admin) may cancel its active session; no reward. Server also cancels/expires abandoned sessions by deadline. |
| `social.completeLanVisit` | `{ peerId: string; direction: 'incoming' or 'outgoing' }` | `src/renderer/ui/visit.ts:55`, `184` | Apply exactly-once visit mood/reward; command opId handles retries. |
| `island.arriveScene` | `{ sceneId: string }` | `src/renderer/ui/island.ts:1134-1145` | Advance tour/seek/visit errands and canonical island position/task state. |
| `island.acceptLetter` | `{ fromNpcId: string; toNpcId: string }` | `src/renderer/ui/island.ts:944-968` | Validate daily letter allowance; set canonical letter state. |
| `island.deliverLetter` | `{ toNpcId: string }` | `src/renderer/ui/island.ts:970-987` | Validate carried letter; award server-RNG yb/loot; emit events. |
| `island.turnInErrand` | `{ npcId: string; errandId: string; itemId?: string }` | `src/renderer/ui/island.ts:989-1006`, `1026-1035` | Validate errand/current items, consume, grant server-RNG reward. |
| `island.startQuiz` | `{ npcId: string; errandId: string }` | `src/renderer/ui/island.ts:1008-1024` | Validate errand; server RNG creates a one-use quiz session and returns canonical question ID/option list; arbitrary client question/option text is rejected. |
| `island.answerQuiz` | `{ quizId: string; optionIndex: number }` | `src/renderer/ui/island.ts:1008-1024` | Validate session/device/expiry; grade, settle one try, persist progress, emit result. |
| `island.fightMonster` | `{ monsterId: string; tactic: string }` | `src/renderer/ui/island.ts:1062-1112` | Validate once/day; server RNG rolls outcome/reward; emit narrative facts. |
| `island.claimGrowthReward` | `{}` | `src/renderer/ui/island.ts:1178-1189` | Apply tier reward once with RNG loot. |
| `island.claimTreasure` | `{}` | `src/renderer/ui/island.ts:1191-1206` | Validate piece state; increment/reset; grant RNG loot when complete. |
| `island.giftNpc` | `{ npcId: string; itemId: string }` | `src/renderer/ui/island.ts:1208-1237` | Validate wanted item/daily flag, consume, grant RNG reward. |
| `island.talkNpc` | `{ npcId: string }` | `src/renderer/ui/island.ts:1114-1132,1156-1163` | Advance talk/chat/seek/visit errand progress and NPC interaction counters exactly once; return presentation facts. |
| `island.visitSpot` | `{ spotId: string }` | `src/renderer/ui/island.ts:1037-1060` | Validate/update errand progress; no client text in canonical state. |
| `island.chat` | `{ npcId: string }` | `src/renderer/ui/island.ts:1156-1163` | Advance chat errand counters exactly once. |
| `island.playGame` | `{ gameKey: string }` | `src/renderer/ui/island.ts:1147-1154` | Advance play errand; actual game reward is separate `game.reward`. |
| `island.refreshNews` | `{ dayKey: string }` | `src/renderer/ui/island.ts:1239-1255` | Generate canonical news facts/day marker with server RNG; prose rendering remains local presentation. |

Island/community AI-created prose remains client presentation. Server events contain stable IDs, counters, rewards, and fallback templates; arbitrary client text is not accepted into `SharedSaveData`.

#### Group F — Fishing and farm (high-risk extraction)

| Command | Payload | Current mutation source | Runtime behavior |
|---|---|---|---|
| `fishing.buy` | `{ fryId: number; quantity: number }` | `src/renderer/pet/fishing.ts:127-163` | Validate room/funds, deduct yb, add fish with runtime game-time/seed. |
| `fishing.feed` | `{ fishId: number }` | `src/renderer/pet/fishing.ts:105-115` | Validate fish/funds, deduct 10, add feed/growth. |
| `fishing.harvest` | `{ fishId: number }` | `src/renderer/pet/fishing.ts:165-176` | Validate/remove fish, grant yb/achievement through RNG/rule path. |
| `fishing.harvestAll` | `{}` | `src/renderer/pet/fishing.ts:192-203` | Harvest ripe fish atomically and update achievement counters. |
| `fishing.speedUp` | `{}` | `src/renderer/pet/fishing.ts:178-190` | Validate daily PD uses, advance fish growth deterministically. |
| `farm.plant` | `{ seedId: string; plotIds: number[] }` | `src/renderer/ui/farm.ts:86-95`; SWF callbacks | Validate seeds/plots/funds, consume, schedule crop maturity. |
| `farm.harvest` | `{ plotIds: number[] }` | Same | Validate ripe plots, harvest, inventory/coins/task effects. |
| `farm.care` | `{ plotIds: number[]; action: 'water' or 'weed' or 'pest' or 'fertilize' }` | Same | Validate/consume care items, update plot state. |
| `farm.clear` | `{ plotIds: number[] }` | Same | Clear selected plots with canonical rules. |
| `farm.buySeed` | `{ seedId: string; quantity: number }` | SWF shop callbacks / `ui/farm.ts` | Validate shop stock/funds, add seeds. |
| `farm.sellProduce` | `{ itemId: string; quantity: number }` | SWF warehouse callbacks / `ui/farm.ts` | Validate inventory, add yb, update state. |

**High-risk note:** Farm rules currently live substantially in `Farm.swf` and Ruffle SharedObject/localStorage (`src/renderer/ui/farm.ts:8-15`, `48-82`). The server runtime must reimplement the canonical crop/pest/coin/reward rules and characterization tests must prove parity for the currently supported farm actions. Server mode cannot launch the client SWF as an authority. Failure to extract any current farm action is a release blocker, not a reason to hide farm in server mode or leave a client-side mutation; the human must explicitly change scope if that is impossible.

Fishing game state currently lives in TypeScript but uses module-level caches and SWF protocol; commands above replace both the cache and SWF request mutators. `ui/fishing.ts` becomes a renderer that sends commands based on SWF `PETSendData` requests and renders returned state/results.

#### Group G — Settings, admin, storage and migration

| Command | Payload | Current source | Authority |
|---|---|---|---|
| `settings.setShared` | `{ key: 'difficulty' or 'undying'; value: boolean or 'easy' or 'standard' }` | `src/renderer/ui/setup.ts:304`; `src/renderer/ui/chat.ts:108-120` | Player; validates shared allowlist and type. `paused` uses `pet.setPaused`. |
| `server.setAdvanceWhileEmpty` | `{ enabled: boolean }` | New setting | Owner. |
| `server.setTimeZone` | `{ timeZone: string }` | New setting | Owner; validate IANA zone, recompute next 06:00 boundary, skip already-passed boundaries in new zone, execute next boundary once. |
| `server.setWeatherCity` | `{ city: string }` | New canonical weather setting | Owner; validate non-empty city, persist `weather_location`, invalidate future unpersisted forecasts, cache/fetch new normalized records. |
| `admin.importPortableBundle` | `{ bundle: PortablePetBundleV1; allowClamp: boolean }` | `src/main/save.ts:78-83`; import/export UI | Owner; validates bundle/schema, backs up current state, applies bounded anchor clamp/no double catch-up, restores engine/RNG/jobs/sessions/environment, emits snapshot. |
| `admin.grantCheat` | `{ stat: 'yb' or 'growth' or 'mood' or 'hunger' or 'clean' or 'health'; amount: number }` | `src/renderer/ui/setup.ts:408-419`; `src/renderer/ui/chat.ts:104-120` | Owner; replaces direct client `addInfo`/`setInfo` cheats. |
| `admin.grantRandomGoods` | `{ type: GoodType; quantity: number }` | `src/renderer/ui/setup.ts:177-181` | Owner; server RNG selects goods, validates quantity/caps, grants inventory/illustrated. |

Device-local settings (opacity, zoom, UI panels, AI keys, etc.) are not commands and never enter the command log.

#### 7.5.1 Command-coverage gate

- Maintain a migration matrix from every current canonical mutation call site (including `update`, `setInfo`, `addInfo`, `earnYb`, `give`, `writeMails`, `saveSpot`/`store` helpers, SWF callbacks, and module `store()` functions) to a semantic command/event and migration group.
- A static coverage test must fail if renderer/shared business code still mutates canonical SaveData outside approved local-only presentation/settings code.
- Every command must have at least one success test, one precondition-failure test, one authorization test where relevant, and an idempotency test for server mode.
- Feature-parity audit: each in-scope feature group A–F is exercised in both local and server mode; a feature cannot be disabled merely because storage is server mode.
- New mutation call sites added later must either use an existing command or add a catalog command + handler + test in the same change.

### 7.6 Command validation and transaction ordering

For each command, server host:

1. Resolve authenticated device/pet and reject unauthorized commands.
2. Check `opId` idempotency; if present, return stored result.
3. Validate payload shape and semantic preconditions against canonical state.
4. Call the pure runtime handler on a clone; handler returns candidate state/events/result or a controlled error.
5. In one SQLite `BEGIN IMMEDIATE` transaction:
   - re-check opId/revision race in the serialized queue;
   - update canonical `save_json` and engine/RNG/scheduler state;
   - append command row and event rows;
   - increment revision for an applied command;
   - update scheduled jobs/settings;
   - commit.
6. Broadcast one ordered projection/event batch to connected clients and return the command result to the requester.
7. On any failure, roll back state/RNG/jobs/events; report `rejected` or `internal` without partial mutation.

No command handler reads the wall clock, client clock, client RNG, or local device settings. Time and environment are supplied by the server host from the canonical engine state/persisted inputs.

## 8. Repository, renderer API, and local-mode execution

### 8.1 Renderer-facing surface

The previous canonical `save(patch)` surface is replaced for gameplay. `load()` and `flush()` remain; command execution and projections are new. Retaining `save(patch)` as a canonical write would contradict the resolved server-authority requirement, so this is the one intentional app-facing API break; repository export/import/reset/admin controls remain available.

```ts
import type { SaveData } from '../save'
import type { PetCommand, CommandResult, SharedSaveData } from './sync/protocol'
import type { DeviceLocalOverlay } from './sync/data-boundary'

export interface Projection {
  save: SaveData
  shared: SharedSaveData
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
}

export interface QQPetApi {
  load(): Promise<SaveData>
  /** Executes a semantic command locally or over the server connection. */
  command(command: PetCommand, options?: { opId?: string }): Promise<CommandResult>
  /** Same unified capability for local and server mode; server requires owner. */
  setAdvanceWhileEmpty(enabled: boolean): Promise<void>
  flush?(): Promise<void>
  /** Device-only settings, position, and UI preferences. Never canonical gameplay. */
  localSettings: {
    update(patch: DeviceLocalOverlay): void
    load(): Promise<DeviceLocalOverlay>
  }
  onProjection(listener: (projection: Projection, events: OrderedEvent[]) => void): void
  onCommandResult(listener: (result: CommandResult) => void): void
  onSyncStatus(listener: (status: RepositoryStatus) => void): void
  onResync(listener: (projection: Projection, events: OrderedEvent[]) => void): void
  // existing export/import/reset/admin surface is repository-routed
}
```

- `command()` resolves with an applied/rejected/duplicate result. The authoritative projection arrives through `onProjection`/`onResync`; the renderer must not mutate canonical fields from the command result itself.
- `load()` returns the latest known projection with device overlay applied. In remote mode it may be a cache and the UI must display connecting/offline status until a server projection arrives.
- `flush()` waits for local output durability or an in-flight remote command result/status reconciliation.
- Device-local settings and position changes use `localSettings.update`; they never send a command or enter the server command log.
- `onProjection` and `onResync` apply full `SharedSaveData` in place, preserve object identities, overlay device-local data, and then invalidate feature caches.
- Business UI must use `command()` and projection selectors. It must not use `SavePatch`, write `save.petInfo`/gameplay arrays directly, or branch on storage mode.

### 8.2 LocalRepository

LocalRepository is a real authority, not a compatibility shim.

- It embeds the same `PetRuntime`/command handlers as the server in Electron main.
- It owns a serialized command queue and a 60s game scheduler in main.
- It persists one `LocalPetDocumentV2` atomically (`save.json` or a versioned successor with an explicit migration/backup). Every command/tick batch and scheduler anchor is committed before the projection is emitted; `flush()` closes the final write barrier on quit/pagehide.
- A crash loses only the uncommitted candidate batch. On restart the local repository resumes from the last committed game time/RNG/jobs/anchor; enabled local advance runs full catch-up, disabled local advance resets the anchor without backfill.
- It emits the same `PetProjection`/ordered events surface to the renderer.
- It uses the same `opId` acceptance semantics internally so command retries from the renderer cannot double-apply.
- It remains fully offline; no WebSocket connection is opened.
- It exposes `setAdvanceWhileEmpty(enabled)` through the unified repository/storage UI capability and persists it in the local v2 document. RemoteRepository maps the same method to the owner command `server.setAdvanceWhileEmpty`.
- Its canonical state and events must be byte-for-byte semantically comparable to a server engine run with the same seed, clock, commands, and environment.

Local scheduler policy:

- While the Electron app is running, local runtime context has `sessionActive=true`, `activeClientCount=1`, so online-time and sign-in online-gift countdown accrue.
- On app shutdown, no process exists. On next launch:
  - if local `advanceWhileEmpty` is true (default, approved deliberate behavior), fast-forward the **full game-world runtime** from `lastSchedulerWallMs` to now using bounded catch-up chunks. Hunger, growth, illness, random events, death, tasks, jobs, travel, farm/fishing, and all other game-clock effects advance. `sessionActive=false`, so online-time and sign-in online-gift countdown do not accrue for the closed interval;
  - if false, reset the scheduler anchor to now and do not backfill the closed interval; pending jobs remain relative to game time.
- During a large closed-interval catch-up, LocalRepository reports `catching_up`, serves the last cache read-only, yields between bounded chunks, and does not accept commands until the final projection/ready. First migration shows a one-time warning and progress; this is an explicit UX/performance change from the legacy task-only resume.
- `advanceWhileEmpty` in local mode is a local-document setting, default `true`; it has the same meaning as the server setting, adapted to “app not running” instead of “zero server clients.”
- Local mode remains fully offline and never depends on a server to initialize RNG, clock, or schema.

### 8.3 RemoteRepository

RemoteRepository owns:

- WSS connection, pairing/token lifecycle, reconnect with jittered backoff;
- local projection cache and device overlay;
- ordered frame/revision/event cursor;
- command envelope generation and at most one in-flight command;
- command-status reconciliation after disconnect;
- snapshot/replay handling and resync requests;
- repository status events.

RemoteRepository never applies a command to canonical state optimistically. It may show a pending UI state, but the SaveData projection changes only when the server sends an authoritative projection.

### 8.4 Renderer/store migration

The renderer store becomes projection-first:

- `save`/`info` remain read-only canonical projections for UI.
- `update()`/`setInfo()`/`addInfo()` no longer mutate shared gameplay fields. They are removed or converted into command dispatch helpers.
- Shared state changes arrive only through projection hydration.
- Presentation events (`eat`, `clean`, `play`, `work`, `travel`, spell bubbles, SWF poses) are played after an accepted command/event; they never write state.
- Pure selectors (`mood`, `stage`, `growthPerMinute`, `fatigue`, `luck`, derived caps, etc.) move to the shared runtime and are imported by renderer as read-only functions.
- Local settings/position updates remain local and do not trigger commands.
- `src/renderer/ui/**` action controls construct commands; `src/renderer/pet/**` becomes presentation/selectors, not an alternate simulation.
- Game windows keep no preload: the pet page starts `game.startSession` before opening one and turns the window-close/duration IPC into `game.reward`; game SWFs never mutate canonical state.

### 8.5 Temporary coexistence

Because the renderer currently owns many rule functions and DOM/SWF presentation, the implementation may temporarily keep the legacy local mutation path while the shared runtime is extracted and the UI is converted group by group.

Rules for temporary coexistence:

- Old and new paths must never mutate the same state in one run.
- The legacy path remains the default only until the command groups are complete; the new runtime is enabled per migration group behind a development flag and extensively characterized.
- Server mode is not exposed until every gameplay mutation group is covered by commands.
- The final switch to shared local runtime must remove or hard-fail the old canonical `update()`/`save(patch)` entry points.
- The final implementation must not contain a server path that accepts patches or a client path that runs game rules.

### 8.6 Local-to-server migration and first enablement

- **Both empty:** server initializes a canonical empty SaveData (`havePet:false`). Client shows the existing egg-selection UI; `pet.adopt` creates the newborn on the server. No “empty bootstrap” admin payload is needed.
- **Server empty, local has pet:** explicit “upload this device” path sends an owner `admin.importPortableBundle` containing shared SaveData plus engine state; server validates/normalizes, backs up before replacing, preserves RNG/jobs/sessions/environment, applies the bounded anchor clamp once, then broadcasts a snapshot. A legacy bare-SaveData upload is converted by the migration adapter with a new deterministic RNG seed and reconstructed schedules.
- **Server has pet, local empty:** explicit “use server pet” path backs up the local cache, hydrates the server projection, overlays local defaults, and writes cache.
- **Both have pet:** explicit choice in the storage admin UI. Never silently overwrite either side.
- **Switch back to local:** owner confirmation, backup server-mode cache and server snapshot, write local v2 document, seed local engine from the latest server shared state/time/RNG policy, switch repository, relaunch. If offline, retain cache but require a later snapshot before claiming freshness.
- **Import:** local mode uses explicit repository/admin import with backup; server mode uses owner `admin.importPortableBundle` and server backup. Imported `SharedSaveData` is validated; device settings stay local.
- **Export:** exports `PortablePetBundleV1` by default, preserving RNG/schedules/sessions/anchor/day-boundary/environment but excluding device settings/secrets. An optional compatibility export may write bare SaveData. Server mode uses owner-only `exportBundle` over WebSocket to obtain the latest portable bundle; it does not use HTTP pet-data endpoints.

### 8.7 Mobile local-runtime hosting (server mode hidden)

- Android, HarmonyOS, and iOS local mode migrate to the same shared runtime. Their TypeScript bridges (`src/android/bridge.ts`, `src/harmony/bridge.ts`, `src/ios/bridge.ts`) host `LocalRepository` and the 60s local scheduler, using native file read/write for the versioned local document.
- The bridge exposes the same preload-compatible `load/command/flush/onProjection/onCommandResult/onSyncStatus` contract to the shared renderer. There is no mobile alternate rule set and no gameplay rule loop in the renderer.
- Mobile `sessionActive=true` while the bridge scheduler is running as the active local app/service; if the OS suspends/kills the process, no ticks run. On next process start, local `advanceWhileEmpty=true` performs the same full closed-interval catch-up as desktop, with `sessionActive=false` for the suspended interval; false freezes/no-backfills.
- Mobile UI hides server mode entirely. Mobile capabilities explicitly report `serverMode: false`; pairing/WSS/RemoteRepository are not bundled into mobile builds in this phase.
- Mobile persistence uses the same `PortablePetBundleV1`/`LocalPetDocumentV2` schema through native bridge methods. The bridge must preserve corrupt-file backups and migrate legacy bare save data before starting the runtime.
- `tsconfig.web.json`, `tsconfig.harmony.json`, the Vite Android/Harmony/iOS builds, and mobile bridge tests must compile/run the shared runtime and command/projection contract. Server-mode code must be tree-shaken or type-gated out of mobile builds.
- There is no mobile-specific canonical command/event vocabulary. Any mobile presentation difference is local overlay only.

## 9. Server authority, scheduler, and persistence

### 9.1 Server responsibilities

The server is the only authority in server mode:

- Owns canonical `SharedSaveData`, all gameplay rule execution, clock, RNG, scheduled jobs/game sessions, `advanceWhileEmpty`, timezone, canonical weather city, and per-day environment inputs/cache.
- Owns sessions, device auth, pairing, command acceptance, idempotency, revision/event sequencing, and broadcast.
- Accepts no client-produced `SavePatch`, RNG state, schedule, clock, reward amount, or final state.
- Runs one serialized runtime queue per pet.
- Persists every accepted command/tick batch atomically before broadcasting.
- Serves projections and event streams over WebSocket only.

### 9.2 Server process model

- One Node 22+ server process, one SQLite database in WAL mode.
- One runtime host per pet; one process-local command/tick serialization queue. Horizontal scaling is out of scope.
- “Zero clients” means zero authenticated pet WebSocket sessions, not zero visible windows; a connected desktop session counts even if its pet window is hidden.
- The process must remain running for `advanceWhileEmpty=true` to advance while zero clients; server downtime is recovered by catch-up on restart when the setting is enabled.
- On startup:
  1. Open SQLite, verify migrations, integrity/quick-check.
  2. Load pet canonical state, engine state, RNG, per-day environment/weather cache, day-boundary keys, `pet_settings`, pending scheduled jobs, and game/exam sessions.
  3. Validate state/schema/RNG/jobs consistency; fail closed on corruption.
  4. Mark `catchingUp` or `ready`.
  5. If `advanceWhileEmpty=true`, schedule bounded catch-up from persisted `lastSchedulerWallMs`; if false and zero clients, freeze and reset the scheduler anchor to now (no backfill).
  6. Rebuild in-memory scheduling queue from persisted jobs; no client may submit commands until ready.
- On SIGTERM/SIGINT: stop accepting commands, flush current transaction, checkpoint WAL if possible, close DB, close sockets, exit.

### 9.3 SQLite schema (MVP)

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE pets (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  command_seq INTEGER NOT NULL DEFAULT 0,
  event_seq INTEGER NOT NULL DEFAULT 0,
  game_time_ms INTEGER NOT NULL,
  last_scheduler_wall_ms INTEGER NOT NULL,
  save_json TEXT NOT NULL,       -- canonical SharedSaveData, versioned
  engine_json TEXT NOT NULL,     -- RNG, per-day environment, day keys, nextScheduledJobId, other engine metadata
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE pet_settings (
  pet_id TEXT PRIMARY KEY REFERENCES pets(id) ON DELETE CASCADE,
  advance_while_empty INTEGER NOT NULL CHECK (advance_while_empty IN (0, 1)),
  time_zone TEXT NOT NULL,
  weather_location TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE scheduled_jobs (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  due_at_game_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_command_seq INTEGER,
  completed_command_seq INTEGER,
  PRIMARY KEY (pet_id, job_id)
);
CREATE INDEX scheduled_jobs_due ON scheduled_jobs(pet_id, status, due_at_game_ms);

CREATE TABLE game_sessions (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  session_token TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('small', 'flash', 'diudiule', 'exam')),
  game_id TEXT NOT NULL,
  started_at_game_ms INTEGER NOT NULL,
  expires_at_game_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'abandoned', 'expired')),
  settled_command_seq INTEGER,
  reward_key TEXT,
  PRIMARY KEY (pet_id, session_token)
);
CREATE INDEX game_sessions_open ON game_sessions(pet_id, status, expires_at_game_ms);

CREATE TABLE commands (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  command_seq INTEGER NOT NULL,
  op_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
  result_json TEXT,
  error_json TEXT,
  revision INTEGER NOT NULL,
  event_seq INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (pet_id, command_seq),
  UNIQUE (pet_id, device_id, op_id)
);

CREATE TABLE events (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  command_seq INTEGER,
  game_time_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (pet_id, event_seq)
);

CREATE TABLE devices (
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  label TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'player')),
  token_hash BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER,
  revoked_at_ms INTEGER,
  PRIMARY KEY (pet_id, device_id),
  UNIQUE (token_hash)
);

CREATE TABLE pairing_codes (
  code_hash BLOB PRIMARY KEY,
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'player')),
  expires_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER
);
```

### 9.4 Persistence invariants

- `pets.revision` increments by exactly one for each committed canonical state batch (one applied command or one scheduler batch containing one or more minute ticks).
- `pets.command_seq` increments once per command record, including rejected commands; it is the total command log cursor.
- `pets.event_seq` increments once per emitted ordered event; event seq is stable and gapless for retained entries.
- `save_json` is the canonical shared gameplay state; `engine_json` contains RNG state, per-day environment cache, last/next day-boundary keys, next job id, and other host-independent engine metadata. `gameTimeMs`/`lastSchedulerWallMs` are scheduler columns; `timeZone`/`advanceWhileEmpty` come from `pet_settings` and are injected into the runtime host. `game_sessions`/`scheduled_jobs` hold their lifecycle rows. Device/local settings are never here.
- `scheduled_jobs` and `game_sessions` are canonical lifecycle tables; runtime structs and rows are updated in the same transaction. There is no second unpersisted timer/session source after commit. On load, the host assembles `EngineState` from `save_json` + `engine_json` + `game_time_ms` + `scheduled_jobs` + `game_sessions` + `pet_settings.time_zone`/`advanceWhileEmpty`.
- Game/exam session tokens are server-issued, high-entropy, one-use, device-bound, and expire in game time. A settled/expired/abandoned token can never be rewarded. Session rows are included in portable bundles and restored on import (subject to device/token validity and expiry).
- `advance_while_empty` and `time_zone` are server settings, not gameplay fields. `time_zone` is validated as IANA and persisted at pet initialization.
- A command row exists for every accepted/rejected command; its unique `(pet_id, device_id, op_id)` is the idempotency boundary. `commandStatus` is scoped to the authenticated device.
- A duplicate `op_id` from the same device returns the stored result and performs no state/engine/event mutation. Cross-device `op_id` reuse is not accepted as a lookup key.
- `BEGIN IMMEDIATE` wraps each command/tick batch. Snapshot, engine state, jobs, command row, and event rows commit atomically. Broadcast occurs only after commit.
- Catch-up commits `gameTimeMs` and `lastSchedulerWallMs` together; crash recovery therefore cannot double-advance a committed minute chunk.
- `time_zone` and day boundaries are fixed for the pet; changing the timezone is an owner admin command that must define how the next daily boundary is recomputed.

### 9.5 Scheduler and `advanceWhileEmpty` details

Already specified in §5.6–5.7. Server integration specifics:

- Scheduler polls every 1s; runtime ticks are whole 60,000ms game minutes. Each tick supplies `activeClientCount = authenticatedSessionCount` and `sessionActive = count > 0`; with zero clients and `advanceWhileEmpty=true`, world effects advance but online-session counters/sign-in gift countdown do not. During local closed-interval catch-up, `activeClientCount=0`, `sessionActive=false`; while the local app is running, they are `1`/`true`.
- On session count transitioning to zero with `advanceWhileEmpty=false`: persist `lastSchedulerWallMs = wallNow`, stop advance, leave jobs pending.
- On first session after an empty/frozen interval with false: persist anchor `lastSchedulerWallMs = wallNow`, do not run missed ticks.
- With true: continue ticks independent of session count. On restart, catch up from persisted anchor to current wall time.
- A command received while `catchingUp` is rejected with `server_catching_up` and `refreshProjection:true`; no command enters the historical catch-up.
- Max catch-up is unbounded in total logical minutes but bounded in transactions: `CATCHUP_CHUNK_TICKS=1440` per transaction/yield. The server reports progress and never loops without yielding.
- Scheduler and command executor use a single per-pet queue. Wall-time ordering only determines when a tick batch becomes due; the canonical event order is the queue order.
- RNG state is advanced inside the same transaction as each tick batch, so a crash/restart reproduces the same sequence from the last committed state.

### 9.6 Backups and operational durability

- **Backups are independent of command/event-log retention.** Use SQLite's online backup API or `sqlite3 .backup` to write a consistent DB snapshot to a separate backup directory.
- Keep at least daily backups, pre-migration backups, and pre-import backups with revision/game-time metadata.
- Command/event log retention defaults: 10,000 entries or 30 days, whichever is greater for pending-command/status needs; do not delete backup files with log pruning.
- A restore must be testable: stop service, replace DB from backup, start, verify schema/checksum/health, then reconnect clients.
- On `advanceWhileEmpty=true`, a restored older backup will be caught up to current wall time only if the setting says so; this is intentional and must be documented.
- Do not copy a live DB+WAL pair manually; use the SQLite backup API.

### 9.7 Observability

Health/readiness should expose:

- `ready` / `catchingUp`, `gameTimeMs`, `wallLagMs`, `revision`, `commandSeq`, `eventSeq`.
- `advanceWhileEmpty`, `timeZone`, `nextTickAtMs`, pending scheduled job count/next due.
- active session count, DB writable/SQLite quick-check, command/event log size, last error.

Metrics/logs:

- command accepted/rejected counts by type/error; duplicate op count; tick count; catch-up chunks/duration; scheduler lag.
- session/auth failures, revoked devices, rate-limit hits.
- backup success/failure, restore smoke status.
- Never log tokens, pairing codes, full command payloads, shared save contents, or AI/search/webhook secrets.

## 10. WebSocket protocol

### 10.1 General rules

- Endpoint: `/v1/sync` over WSS in production. Plain `ws://` only for loopback/self-tests.
- JSON UTF-8 frames. No binary encoding in the MVP.
- The first frame must be `hello` with a device token or pairing code within 5 seconds; unauthenticated sockets are closed.
- Long-lived tokens are never in query strings, paths, or HTTP headers; they travel only in the WSS `hello` frame.
- The protocol is command-oriented. There is no `SavePatch`, tick patch, RNG field, scheduled-job field, or reward amount supplied by a client.
- `protocolVersion` is integer `1` for this spec. Unknown major versions are rejected; optional future fields may be ignored after a known major.
- HTTP is only `/healthz`/`/readyz`; all pet data, commands, snapshots, events, and resync use WebSocket.
- `requestId` correlates request/response; `opId` is the durable idempotency key for a command.
- Events and projection frames are ordered by monotonic `eventSeq` and `revision`. Clients stop on a gap and request resync.
- A full `SharedSaveData` snapshot is the projection unit. Whole-projection broadcast is safe here because the server is the sole writer and the snapshot is authoritative. Device overlay is applied in main, never sent to other clients.

### 10.2 TypeScript message shapes

```ts
import type { Sex, SharedSaveData, Settings } from '../save'

export const PROTOCOL_VERSION = 1 as const
export const SAVE_SCHEMA_VERSION = 1 as const
export type ProtocolVersion = typeof PROTOCOL_VERSION
export type DeviceRole = 'owner' | 'player'
export type CombatStat = 'yb' | 'growth' | 'mood' | 'hunger' | 'clean' | 'health'

export interface CommandPayloadMap {
  'pet.adopt': { sex: Sex }
  'pet.reset': Record<string, never>
  'pet.bury': Record<string, never>
  'pet.rename': { name?: string; host?: string }
  'pet.setPaused': { paused: boolean }
  'pet.pokeFace': { spotId: string }
  'pet.cheer': Record<string, never>
  'inventory.buy': { type: string; itemId: string; quantity: number }
  'inventory.use': { type: string; itemId: string; quantity?: number }
  'medical.treat': { mode: 'doctor' | 'owned'; itemId?: string }
  'vip.buyPinkDiamond': { days: number }
  'vip.clearPinkDiamond': Record<string, never>
  'vip.buySweetheart': { days: number }
  'vip.setSweetheart': { enabled: boolean }
  'travel.completeCollection': Record<string, never>
  'job.startWork': { jobId: string }
  'job.startStudy': { courseId: string }
  'job.startTravel': Record<string, never>
  'activity.stop': Record<string, never>
  'task.claim': { tab: 'daily' | 'ddw' | 'growth' | 'travel'; index: number }
  'exam.start': { subject: string }
  'exam.submit': { examId: string; answers: number[] }
  'signin.sign': Record<string, never>
  'signin.drawGrowth': Record<string, never>
  'signin.claimOnlineGift': Record<string, never>
  'signin.claimBirthdayGift': Record<string, never>
  'mail.claim': { mailId: string }
  'mail.claimAll': Record<string, never>
  'mail.delete': { mailId: string }
  'mail.deleteAll': { scope: 'claimed' }
  'game.startSession': { gameId: string; kind: 'small' | 'flash' }
  'game.reward': { sessionToken: string }
  'diudiule.startSession': Record<string, never>
  'diudiule.reward': { sessionToken: string }
  'game.abandonSession': { sessionToken: string }
  'social.completeLanVisit': { peerId: string; direction: 'incoming' | 'outgoing' }
  'island.arriveScene': { sceneId: string }
  'island.acceptLetter': { fromNpcId: string; toNpcId: string }
  'island.deliverLetter': { toNpcId: string }
  'island.turnInErrand': { npcId: string; errandId: string; itemId?: string }
  'island.startQuiz': { npcId: string; errandId: string }
  'island.answerQuiz': { quizId: string; optionIndex: number }
  'island.fightMonster': { monsterId: string; tactic: string }
  'island.claimGrowthReward': Record<string, never>
  'island.claimTreasure': Record<string, never>
  'island.giftNpc': { npcId: string; itemId: string }
  'island.talkNpc': { npcId: string }
  'island.visitSpot': { spotId: string }
  'island.chat': { npcId: string }
  'island.playGame': { gameKey: string }
  'island.refreshNews': { dayKey: string }
  'fishing.buy': { fryId: number; quantity: number }
  'fishing.feed': { fishId: number }
  'fishing.harvest': { fishId: number }
  'fishing.harvestAll': Record<string, never>
  'fishing.speedUp': Record<string, never>
  'farm.plant': { seedId: string; plotIds: number[] }
  'farm.harvest': { plotIds: number[] }
  'farm.care': { plotIds: number[]; action: 'water' | 'weed' | 'pest' | 'fertilize' }
  'farm.clear': { plotIds: number[] }
  'farm.buySeed': { seedId: string; quantity: number }
  'farm.sellProduce': { itemId: string; quantity: number }
  'settings.setShared': {
    key: 'difficulty' | 'undying'
    value: boolean | 'easy' | 'standard'
  }
  'server.setAdvanceWhileEmpty': { enabled: boolean }
  'server.setTimeZone': { timeZone: string }
  'server.setWeatherCity': { city: string }
  'admin.importPortableBundle': { bundle: PortablePetBundleV1; allowClamp: boolean }
  'admin.grantCheat': { stat: CombatStat; amount: number }
  'admin.grantRandomGoods': { type: string; quantity: number }
}

export type PetCommand = {
  [K in keyof CommandPayloadMap]: { type: K; payload: CommandPayloadMap[K] }
}[keyof CommandPayloadMap]

export interface ClientHello {
  t: 'hello'
  v: ProtocolVersion
  requestId: string
  /** Optional during pairing; server derives it from the token/code. If supplied it must match. */
  petId?: string
  deviceId?: string
  lastRevision?: number
  lastEventSeq?: number
  appVersion: string
  auth:
    | { kind: 'token'; token: string }
    | { kind: 'pairing'; code: string; deviceLabel: string }
}

export interface Welcome {
  t: 'welcome'
  v: ProtocolVersion
  requestId: string
  connectionId: string
  petId: string
  deviceId: string
  deviceRole: DeviceRole
  protocolVersion: ProtocolVersion
  saveSchemaVersion: number
  serverTimeMs: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  headRevision: number
  headEventSeq: number
  catchingUp: boolean
  delivery: 'none' | 'snapshot' | 'replay' | 'replay+snapshot'
  /** One-time field only when auth.kind === 'pairing'. Persist locally; never log. */
  issuedToken?: string
}

export interface OrderedEvent {
  eventSeq: number
  revision: number
  commandSeq?: number
  gameTimeMs: number
  type: string
  payload: Record<string, unknown>
}

export interface SnapshotMessage {
  t: 'snapshot'
  v: ProtocolVersion
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  save: SharedSaveData
}

export interface ReplayMessage {
  t: 'replay'
  v: ProtocolVersion
  fromEventSeq: number
  toEventSeq: number
  events: OrderedEvent[]
}

export interface ReadyMessage {
  t: 'ready'
  v: ProtocolVersion
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  catchingUp: boolean
}

export interface ProjectionMessage {
  t: 'projection'
  v: ProtocolVersion
  revision: number
  eventSeq: number
  gameTimeMs: number
  timeZone: string
  advanceWhileEmpty: boolean
  save: SharedSaveData
  /** Ordered events introduced by this revision/batch. */
  events: OrderedEvent[]
}

export interface CommandRequest {
  t: 'command'
  v: ProtocolVersion
  requestId: string
  opId: string
  command: PetCommand
  /** Diagnostics only; server may ignore this for gameplay decisions. */
  observedRevision?: number
}

export interface WireCommandResult {
  t: 'commandResult'
  v: ProtocolVersion
  requestId: string
  opId: string
  status: 'applied' | 'rejected' | 'duplicate'
  commandSeq: number
  revision: number
  eventSeq: number
  result?: Record<string, unknown>
  error?: {
    code: string
    message: string
    refreshProjection: boolean
  }
}

export interface CommandStatusRequest {
  t: 'commandStatus'
  v: ProtocolVersion
  requestId: string
  opId: string
}

export interface CommandStatusResult {
  t: 'commandStatusResult'
  v: ProtocolVersion
  requestId: string
  opId: string
  status: 'applied' | 'rejected' | 'not_applied'
  result?: WireCommandResult
}

export interface PortableBundleRequest {
  t: 'exportBundle'
  v: ProtocolVersion
  requestId: string
}

export interface PortableBundleMessage {
  t: 'portableBundle'
  v: ProtocolVersion
  requestId: string
  bundle: PortablePetBundleV1
}

export interface ResyncRequest {
  t: 'resync'
  v: ProtocolVersion
  requestId: string
  lastRevision?: number
  lastEventSeq?: number
}

export interface ErrorMessage {
  t: 'error'
  v: ProtocolVersion
  requestId?: string
  code:
    | 'auth_failed'
    | 'protocol_mismatch'
    | 'unauthorized'
    | 'rate_limited'
    | 'invalid_frame'
    | 'payload_too_large'
    | 'server_catching_up'
    | 'internal'
  message: string
  revision?: number
  refreshProjection: boolean
}

export interface PingMessage {
  t: 'ping'
  v: ProtocolVersion
  nonce: number
}

export interface PongMessage {
  t: 'pong'
  v: ProtocolVersion
  nonce: number
  serverTimeMs: number
}

export type ClientToServer =
  | ClientHello
  | CommandRequest
  | CommandStatusRequest
  | PortableBundleRequest
  | ResyncRequest
  | PingMessage

export type ServerToClient =
  | Welcome
  | SnapshotMessage
  | ReplayMessage
  | ReadyMessage
  | ProjectionMessage
  | WireCommandResult
  | CommandStatusResult
  | PortableBundleMessage
  | ErrorMessage
  | PongMessage
```

`CommandPayloadMap` is normative for the MVP command catalog; the table in §7.5 defines each command's semantics and current-source migration group.

Event `type` values are stable semantic identifiers. The MVP set includes at least:

- `pet.statsChanged`, `pet.levelChanged`, `pet.illnessChanged`, `pet.died`
- `inventory.changed`, `item.consumed`, `reward.granted`
- `activity.started`, `activity.completed`, `task.progress`, `task.claimed`
- `mail.arrived`, `mail.claimed`, `signin.changed`, `vip.changed`
- `game.sessionStarted`, `game.sessionSettled`
- `island.errandChanged`, `island.combatSettled`, `island.rewardGranted`
- `farm.changed`, `fishing.changed`
- `system.snapshotBoundary`, `system.catchUpCompleted`

Event payloads contain stable IDs/counters/outcome data needed for presentation; they do not replace the canonical projection and must never contain secrets or device-local fields.

### 10.3 Normal flow

```text
client                                         server
  | ---- hello(token/pairing,lastSeq,lastRev) ----> |
  | <--- welcome {delivery, catchingUp} ----------- |
  | <--- [replay events] --------------------------- |
  | <--- [snapshot] -------------------------------- |
  | <--- ready ------------------------------------- |
  | ---- command {opId, requestId, command} --------> |
  | <--- commandResult {applied/rejected/duplicate}  |
  | <--- projection {full save, ordered events} ----- |  to all clients
```

- Accepted command: server sends `commandResult` to the submitter and a `projection` to all clients in the committed order. The submitter applies the authoritative projection; it does not apply its own command result as a state delta.
- Rejected command: server sends `commandResult`; if `refreshProjection` is true or observedRevision is behind, it also sends the current `projection`.
- A command can be valid against current server state even if the client's UI was stale; server validation/preconditions decide. This is not a client patch merge.
- Because a projection is a full authoritative snapshot, revision jumps caused by scheduler/catch-up batches are valid; clients apply projections in monotonic revision order. If revision goes backwards or the save schema/version is unexpected, they stop and resync.
- `events` in a projection are ordered and best-effort for presentation. If a client cannot establish continuity of `eventSeq` for narrative replay, it requests resync/snapshot; the full state in the projection is still authoritative and never replaced by event payloads.
- `advanceWhileEmpty` and `timeZone` changes are server settings; their next projections carry the new values. Local mode has its own equivalent settings in the local document.

### 10.4 Reconnect, replay, and idempotency

- Client sends `lastRevision` and `lastEventSeq` in `hello`.
- `delivery: 'none'`: client is current; wait for live projections.
- `delivery: 'replay'`: only UI events were missed and event retention covers them; server sends `replay`, then `ready`. The client still needs the current projection if its cached revision differs; it must verify.
- `delivery: 'snapshot'`: state/revision gap or event retention gap; send full snapshot then ready. An owner `exportBundle` request returns the portable bundle for server→local detach; it is separate from normal projection sync.
- `delivery: 'replay+snapshot'`: send retained UI events and then the current snapshot.
- After a socket closes before a command result, the repository must query `commandStatus` with the same `opId` on reconnect, not send a blind new command. If `not_applied`, it discards the pending record after hydrating the latest projection and requires an explicit user retry with a fresh opId. If applied/rejected, it uses the stored result and then takes the latest projection.
- A duplicate command `opId` from the same device never executes the handler or consumes RNG; it returns the stored `commandSeq`/revision/result. `commandStatus` only resolves commands owned by the authenticated device.
- A command is applied in server arrival order. There is no baseRevision CAS or client retry with a new opId after a semantic rejection.
- The client never queues commands while offline. The single pending/reconciliation record from §7.3 is not a queue.

### 10.5 Limits and close behavior

Defaults, configurable server-side:

| Limit | Default |
|---|---|
| Auth hello | 16 KiB, 5s to authenticate |
| General WebSocket frame | 16 MiB |
| Command payload | 256 KiB (admin canonical import up to snapshot limit) |
| Snapshot/projection payload | 16 MiB |
| Events per replay | 10,000 |
| Commands per second per device | 10, burst 20 |
| Connections per pet | 8 |
| Ping interval | 20s |
| Idle timeout | 60s |
| Catch-up chunk | 1,440 ticks (one game day) |
| Scheduler poll | 1s |
| Game tick | 60s game time |

Close/error application codes:

- `4000 auth_failed`
- `4001 protocol_mismatch`
- `4002 superseded` (invalid/revoked session)
- `4003 rate_limited`
- `4004 invalid_frame`
- `4005 payload_too_large`
- `4006 server_error`

Malformed frames may be dropped or closed; oversized frames are closed with `4005`. Server logs must redact auth payloads, command payloads, and save contents.

## 11. Identity, authentication, and secret handling

### 11.1 Pairing and roles

- The server operator initializes a pet and mints a one-time pairing code via a server CLI command. No out-of-repo hosted service is required.
- Pairing codes contain at least 128 bits of randomness, expire after 10 minutes, are single-use, and are stored only as hashes server-side.
- A pairing request over WSS `hello` creates a device record and returns a per-device token once in `welcome.issuedToken`.
- Device roles: `owner` and `player`. The first device is `owner`; the operator chooses the role for subsequent pairing codes. Only owner may issue admin/server-setting/import commands or revoke devices.
- Device revocation is persisted; revoked/unknown tokens fail authentication on the next handshake.
- Device tokens contain at least 256 bits of randomness and are stored only as hashes server-side.
- Pairing and auth errors are rate-limited and do not reveal whether a particular token/pet exists.

### 11.2 Client token storage

- The device token never enters renderer memory and is never returned by a public repository status/config API.
- Electron main stores it via `safeStorage` in a separate file (e.g. `userData/remote-token.bin`).
- If `safeStorage` is unavailable, fail closed or use an explicitly approved 0600 fallback; never put tokens in `save.json`, the projection cache, or `sync-config.json`.
- Non-secret sync metadata (mode, server URL, petId, deviceId, lastRevision/eventSeq) lives in a separate local config.
- The pairing code is entered through the storage admin UI, sent to main, and exchanged there. The long-lived token is never returned to the renderer.

### 11.3 Transport and server secrets

- Production is WSS only, behind a TLS reverse proxy (Caddy/Nginx). Plain WS is allowed only for loopback/self-tests.
- Long-lived tokens/pairing codes never appear in URLs, query strings, paths, or HTTP headers. They travel only in the first WSS frame.
- Server logs redact auth frames, command payloads, save bodies, and all AI/search/webhook credentials.
- Server snapshots/commands/events contain no device settings or secrets: no `aiKey`, `searchKey`, `webhookToken`, token values, pairing codes, window position, zoom, or display IDs.
- TLS private keys live in the proxy/operator environment, never in the app or DB.
- Rate/size limits from §10.5 are enforced before parsing large payloads where practical.

## 12. Server package, deployment, and operations

### 12.1 Package layout

```text
server/
  package.json
  package-lock.json
  tsconfig.json
  src/
    index.ts          # process lifecycle, HTTP health, signal handling
    config.ts
    db.ts             # SQLite migrations/transactions
    auth.ts           # pairing, tokens, devices
    session.ts        # WS authentication/session registry
    runtime-host.ts   # one runtime queue per pet
    scheduler.ts      # ticks, catch-up, advanceWhileEmpty
    command-service.ts# validation/transaction/idempotency/event log
    hub.ts            # ordered projection/event broadcast
    validation.ts
  test/
  Dockerfile
  README.md
```

- Node.js 22+; server-only dependencies `ws` and `better-sqlite3` (do not add to the Electron root package).
- The server imports the shared runtime/protocol/schema from `src/shared/pet-runtime/**` or `src/shared/sync/**` at build time; it must not import DOM, Electron, Ruffle, or renderer UI.
- Shared runtime code is dependency-free beyond standard JSON/content modules.
- SQLite is the only persistent store in the MVP. Use WAL, migrations, transactions, and the online backup API.

### 12.1.1 Operator CLI

Provide server-package scripts:

```text
npm --prefix server run init -- --pet-id default [--time-zone Asia/Shanghai] [--weather-city 北京]
npm --prefix server run pair -- --pet-id default --role player
npm --prefix server run backup -- --pet-id default
npm --prefix server run revoke-device -- --pet-id default --device-id <id>
```

- `init` creates the canonical empty pet + empty engine state + pet settings and prints a one-time pairing code.
- `pair` mints an owner/player pairing code; only a hash is stored.
- `backup` invokes the same SQLite online backup path used by scheduled backups.
- No out-of-repo hosted service is required. Operators run the local package/container against their chosen WSS endpoint.

### 12.2 Configuration defaults

```text
QQPET_SYNC_BIND=127.0.0.1
QQPET_SYNC_PORT=8787
QQPET_SYNC_DB=/var/lib/qqpet-sync/qqpet.sqlite
QQPET_SYNC_BACKUP_DIR=/var/lib/qqpet-sync/backups
QQPET_SYNC_TIME_ZONE=              # optional IANA zone; resolved host zone persisted per pet
QQPET_SYNC_WEATHER_LOCATION=       # canonical server weather city; persisted per pet
QQPET_SYNC_ADVANCE_WHILE_EMPTY=1   # initial pet setting; dynamic setting is persisted in DB
QQPET_SYNC_CATCHUP_CHUNK_TICKS=1440
QQPET_SYNC_COMMAND_RETENTION=10000
QQPET_SYNC_EVENT_RETENTION=10000
QQPET_SYNC_LOG_RETENTION_DAYS=30
QQPET_SYNC_MAX_FRAME_BYTES=16777216
QQPET_SYNC_MAX_COMMAND_BYTES=262144
QQPET_SYNC_LOG_LEVEL=info
```

- `advanceWhileEmpty` can be changed through owner UI after pairing; the env value only seeds the initial pet setting.
- The scheduler poll runs every 1s; game minute is 60s. `advanceWhileEmpty=true` requires the service to remain running. `systemd` should use `Restart=always` (or `on-failure` plus operator monitoring) and Docker Compose should use a restart policy.
- No multi-tenant or horizontal-scale claim. One SQLite file and one server process per deployment.

### 12.3 Docker, systemd, and TLS

- `node:22-bookworm-slim` multi-stage Dockerfile; non-root runtime user.
- Persistent volume for `/var/lib/qqpet-sync` (DB + backups); healthcheck calls `/healthz`.
- Docker Compose example with a named volume and a TLS proxy (Caddy recommended); WebSocket upgrade enabled and read timeout longer than ping interval.
- systemd unit:
  - `ExecStart=node /opt/qqpet-sync/server/dist/index.js`
  - `StateDirectory=qqpet-sync`
  - `Restart=always`
  - `User=qqpet-sync`
  - restrictive `ProtectSystem`/`PrivateTmp` and write access only to the state directory.
- Reverse proxy must pass `Upgrade`/`Connection` headers, terminate TLS, and set reasonable body/time limits.
- Health endpoint must report scheduler/catch-up status, DB writable, session count, revision, and game time without shared state contents.
- Optional Prometheus metrics: commands applied/rejected/duplicate, tick batches, catch-up chunks/lag, sessions, auth failures, backups, DB size.
- Structured JSON logs include pet/device/command IDs, revision/eventSeq, duration, error code; never payload/save/token content.

### 12.4 Backups and restore

- Run a scheduled SQLite online backup independent of command/event-log retention.
- Keep daily backups plus pre-migration/pre-import backups; verify checksum/schema and store revision/gameTime metadata.
- Restore procedure: stop service, replace DB from a consistent backup, start service, verify health/revision/schema, reconnect clients and let them snapshot.
- Test restore in CI/ops smoke test.
- If `advanceWhileEmpty=true`, a restored older snapshot is caught up to current wall time after startup; if false and there are zero clients, it freezes until a client connects and does not backfill. This must be documented in the restore runbook.

## 13. Settings, storage UI, and mode switching

### 13.1 Administrative storage surface

Add an explicit storage pane in the setup UI (under “存档” or a dedicated “数据” admin tab). It may show:

- Local vs server mode.
- Server URL and pairing/connect flow.
- Device label/role and connection status.
- Unified `setAdvanceWhileEmpty(enabled)` capability sourced from LocalRepository or owner server command; same semantics for server zero-client intervals and local app-closed intervals.
- Server timezone, canonical weather city, game time/revision/eventSeq status.
- Initial-source choice: upload this device's pet vs use server pet.
- Latest snapshot/revision, catch-up/offline status, last error.
- Export/import/reset/backup controls and switch-back-to-local confirmation.

This pane is the only business-adjacent UI that knows backend details. The rest of the game UI operates on commands/projections and never checks storage mode.

### 13.2 Business UI rules

- Business panels call typed `command(command)` or local presentation helpers; they never call `update()` for shared game state.
- UI reads the projection and shared pure selectors. It may show pending state while a command is in flight.
- UI does not apply command effects optimistically to canonical state. It renders the next authoritative projection; presentation events can then drive animations/speech.
- Shared settings (`paused`, `difficulty`, `undying`) are edited through commands.
- All other settings are written via `localSettings.update` and remain local.
- Shared setting rows may show “同步”, local setting rows may show “仅此设备”. Secrets are never offered as syncable.
- Conflicts/all rejections show a generic error and refresh/hydrate the projection; no silent automatic retry.
- Local mode uses the same command/projection flow; UI cannot tell whether the authoritative engine is in main or on the server except through generic status/admin surfaces.

### 13.3 Mode switching and migration flows

- **Both empty:** server canonical state starts `havePet:false`; the client shows the normal egg-adoption UI and issues `pet.adopt`; no generic bootstrap payload is needed.
- **Upload local to empty server:** owner-only `admin.importPortableBundle` with shared data plus engine state, validation, pre-import server backup, bounded anchor clamp/no double catch-up, snapshot broadcast.
- **Use server pet:** back up the local cache, hydrate shared snapshot, overlay device-local values, write local cache, switch repository.
- **Both have pets:** explicit modal choice; no silent overwrite.
- **Switch back to local:** confirm, fetch/latest snapshot if possible, back up server cache and server canonical state, write local v2 document with the portable bundle (shared state + engine/RNG/schedules/sessions/environment/timezone/advance policy), apply the same anchor clamp/no-double-catch-up rules, switch to LocalRepository, relaunch. If offline, require explicit acknowledgement that the cache may be stale.
- **Server import/reset:** reset and adoption are explicit server commands. Import is an owner command with validation/backup. There is no payload-free “admin replace” trick and no client Patch bypass.
- **Local import/export:** preserve current user expectations and legacy import compatibility, but route through LocalRepository/engine and back up old files.
- **AdvanceWhileEmpty UI:** one unified `setAdvanceWhileEmpty(enabled)` capability is exposed by both repository modes. In server mode, false→true affects future zero-client intervals only and true→false freezes when the last client disconnects. In local mode, the setting is persisted in the local v2 bundle and applies to future app-closed intervals; it never retroactively backfills a past disabled interval. The current value is displayed in storage status.
- **Device-local data:** position, UI/display settings, AI/search/webhook secrets, and presentation caches are preserved across mode switches and are never uploaded.

### 13.4 Local-mode behavior after migration

- Local mode is still fully offline and runs the same deterministic runtime in Electron main (desktop) or the native bridge host (Android/Harmony/iOS).
- Local `advanceWhileEmpty` defaults to `true`; while the app is closed/suspended, the next launch fast-forwards the full game world with the same bounded scheduler, including hunger, growth, illness, random events, death, tasks, jobs, and all other game-clock effects. `sessionActive=false` during the closed catch-up, so online-time/sign-in online-gift counters do not accrue. This is an approved deliberate behavior change from the old task-only resume.
- The first migration/launch shows a one-time warning and catch-up progress; commands remain unavailable until catch-up completes. Large intervals are processed in bounded chunks and may take noticeable time; status/health must expose progress.
- Setting `advanceWhileEmpty=false` freezes the closed interval and resumes without backfill.
- Local save/import/export and corrupt-file recovery remain user-facing features, with a one-time format migration and backup.
- No renderer rule function may remain the local authority; the local repository is the authority on every host.
- The old renderer-driven mutation path is removed from desktop and mobile production before the local switch is declared complete.
- Mobile local mode has no server-mode entry point; desktop remains the only server-mode host.

## 14. Failure and edge-case semantics

| Scenario | Required behavior |
|---|---|
| A feeds; B is online | Server commits one command; A consumes exactly one food; B receives the next full projection/event batch; both match revision/eventSeq; target p95 ≤1s LAN/loopback. |
| Two clients issue conflicting gameplay commands | Server serializes them. Commands validate against current state; the second may apply if still valid or reject with a clear error. No client patch overwrites another. |
| Stale UI opens a screen | The command is validated against canonical state; if unavailable/rejected, the client gets an error and current projection. No blind retry. |
| Socket drops after command send, before result | UI remains frozen/read-only. On reconnect `commandStatus(opId)` returns `applied`, `rejected`, or `not_applied`. Applied/rejected → deliver result/projection and unlock; not_applied → no automatic resend, discard pending record, unlock and offer explicit retry with a fresh opId. |
| Duplicate command request | Stored result returned; no state/RNG/job/event mutation. |
| Server has zero clients, `advanceWhileEmpty=true` | Scheduler continues; world hunger/growth/tasks/random events advance; `onLineTime`/`onlineDataTime`/sign-in online-gift countdown do not. Reconnect gets changed world state. |
| Server has zero clients, `advanceWhileEmpty=false` | Game time freezes; scheduled jobs/sessions remain pending; reconnect resumes without backfilling the empty interval. |
| Server restart, enabled | Load snapshot/RNG/jobs, catch up from persisted wall anchor in bounded chunks, deterministically continue. |
| Server restart, disabled | No clients after start; freeze at current game time; no empty-interval catch-up. |
| Crash during catch-up | Last committed chunk remains; uncommitted candidate/RNG is discarded; restart resumes from committed anchor/snapshot. |
| Client attempts direct SaveData mutation or old SavePatch | No canonical state change. Protocol has no patch commit; renderer legacy mutation path is removed/guarded. |
| Shared setting changed | Owner/player command; server validates allowlist; all clients receive projection; device-local setting changes never go to server. |
| UI/display position changes | Local overlay only; never appears in commands, projections, DB, or logs. |
| Farm panel open while server changes farm | Farm UI must refresh from projection, discard stale SWF scratch state, and not write a local canonical blob. |
| Local mode app closed with advance true | Next launch runs full world catch-up (hunger/growth/illness/random/death/tasks/jobs/farm/fishing) in bounded chunks; online counters do not accrue; app is read-only/catching-up until complete. |
| Local mode app closed with advance false | Next launch freezes the closed interval and resumes without backfill. |
| Game/diudiule reward token invalid or replayed | Reject; no reward/task counter/time mutation; settle only server-issued device-bound unexpired tokens before deadline. |
| Timezone changed | Recomputed next 06:00 boundary runs once; already-passed boundaries in the new zone are skipped; no duplicate daily/sign-in/mail/VIP rewards. |
| Weather forecast unavailable | Persist deterministic seeded fallback per game-day key with provenance `fallback`; canonical weather city is used, never client `weatherCity`. |
| Portable import has old/future anchor | Clamp to `[wallNow-48h, wallNow+5m]`, preserve game time, record `importClamped`, run at most one enabled catch-up. |
| Mobile tries server mode | Hidden/not built; bridge exposes local mode only with shared runtime and command/projection contract. |
| Import/export | Explicit repository/admin operation; pre-import backup; portable bundle includes shared SaveData + engine state; server import owner-only and broadcast; device settings/secrets excluded; anchor clamp prevents double catch-up. |
| Unauthorized/revoked device | Reject auth/commands, rate-limit, never reveal token/pet details. |
| Server catching up | `welcome.catchingUp=true`; commands return `server_catching_up`; final snapshot/ready when caught up. |
| Unknown/invalid command | Reject with `invalid_payload`/`not_available`; no partial state/RNG mutation; refresh projection if requested. |
| Old local save format | One-time migration with backup; export/import compatibility; corrupt files preserved. |

## 15. Acceptance criteria

The implementation is not accepted unless all of the following are demonstrated with evidence.

1. **Two-client canonical identity:** two Electron clients connected to the same server converge to identical serialized `SharedSaveData`, `revision`, and `eventSeq` after a command batch. UI-only fields may differ locally.
2. **Realtime feed:** a feed command accepted on client A consumes exactly one inventory item and increments exactly one relevant task counter; client B's projection/display updates within **p95 ≤ 1s on LAN/loopback** (CI timeout 3s).
3. **One clock with two clients:** with two clients connected, exactly one canonical game minute is advanced per wall-clock minute (plus deterministic catch-up only when configured); no duplicate ticks or reward paths exist.
4. **Server-owned zero-client progression:** with at least one pet created and no authenticated clients connected, `advanceWhileEmpty=true` advances hunger/growth/tasks and executes deterministic random events. Reconnecting without any user command shows the advanced canonical state.
5. **Frozen zero-client behavior:** with `advanceWhileEmpty=false`, game time and pending scheduled jobs do not advance while zero clients are connected; reconnecting does not backfill the empty interval.
6. **Restart determinism:** after a server restart with the same canonical state, RNG state, schedule, clock inputs, and environment inputs, applying the same command/tick sequence produces identical state and event sequence. Catch-up after a real restart advances exactly once.
7. **No duplicate rewards:** a work/study/travel/task reward, feed item, or game reward is granted exactly once across lost responses, reconnects, and server restart; no reward is granted twice by catch-up.
8. **No client canonical mutation:** the WebSocket protocol rejects/never accepts client SavePatch/tick/reward/state payloads; renderer direct `update()`/`setInfo()` on shared fields is removed or blocked. Tests that attempt the legacy path do not change server or LocalRepository canonical state.
9. **No leaks:** `lastX/lastY`, display/UI settings, `aiKey`, `searchKey`, `webhookToken`, server tokens, pairing codes, and presentation prose are absent from server snapshots, command/event payloads, projections, logs, and backups intended for shared use.
10. **Local-mode parity:** LocalRepository and the server, given the same initial state, seed, clock inputs, environment inputs, and command/tick sequence, produce the same semantic SharedSaveData and ordered events. Local mode remains fully offline.
11. **Local migration:** old bare `save.json` and original `config.json` imports migrate with backups; corrupt-file backup, export/import, reset, and existing desktop behaviors remain usable.
12. **Bootstrap/reset/adopt:** both-empty setup uses server canonical empty state + `pet.adopt`; reset is an explicit server command; no ambiguous payload-free bootstrap/admin path exists.
13. **Backups:** a backup can be created and restored independently of command/event-log retention; health/schema/game state verification passes after restore.
14. **Settings boundary:** shared settings are applied server-side; local/device settings and secrets never enter a command/log/projection. `advanceWhileEmpty` changes take effect exactly as specified.
15. **Operational readiness:** health/readiness, WSS auth, rate/size limits, DB WAL/migrations, scheduler catch-up status, and logs/metrics work without exposing secrets or save contents.
16. **Online-time split:** with `advanceWhileEmpty=true` and zero clients, world state advances but `onLineTime`, `onlineDataTime`, and the sign-in online-gift countdown do not. With at least one authenticated client, all three accrue. Local closed-app full catch-up uses the same split.
17. **Canonical weather model:** server mode uses the owner-configured weather city; weather is stored per game-day key with condition, temperatures (including `tomorrowMax`), provenance, and fetch time; missing days use deterministic seeded fallback; client `weatherCity` never appears in canonical data/projections/DB.
18. **Game-session security:** `game.reward`/`diudiule.reward` accept only server-issued, device-bound, unexpired, unsettled tokens; fabricated/replayed/wrong-device/expired/abandoned tokens and arbitrary reward amounts are rejected; task counter changes are exactly once and match the documented game/diudiule integration.
19. **Portable bundle round-trip:** export/import preserves shared SaveData, RNG, scheduled jobs/sessions, scheduler anchor, timezone/weather location/advance policy, day-boundary state, and environment cache. Import anchor clamping is bounded; no double catch-up occurs across import/restart/detach.
20. **Timezone change semantics:** eastward/westward and DST changes skip already-passed new-zone boundaries, schedule the next 06:00 exactly once, and do not double-run daily tasks, sign-in, mail, fish limits, or VIP settlement.
21. **Mobile local runtime:** Android/Harmony/iOS local mode hosts the shared LocalRepository/runtime and command/projection contract, uses the same v2 portable document, hides server mode, and passes typecheck/build plus local/server parity tests. Mobile server mode is not exposed.
22. **Feature parity:** farm, fishing, island, small games, mail, sign-in, jobs, travel, and shop/inventory remain available in server mode; the command-coverage gate proves every canonical mutation has a handler, with no feature hidden by a storage-mode UI branch.
23. **Local closed-period full progression:** with local `advanceWhileEmpty=true`, a full closed interval advances world effects (hunger, growth, illness, random events, death, tasks, jobs, farm/fishing) in bounded chunks, while online-session counters do not accrue; the UX exposes catch-up progress/readiness and legacy task-only behavior is intentionally removed.

## 16. Test matrix

### 16.1 Deterministic runtime and extraction tests

- Characterization of each migration group with a recorded `Math.random` sequence and fixed time:
  - core minute tick, decay, growth, level/caps, health/illness, death;
  - items/use/buy/medicine/timed goods/achievements;
  - work/study/travel deadlines, task counters, exams;
  - daily resets, sign-in, mail, VIP, fish daily limits;
  - games/social/island decisions and per-day weather inputs;
  - farm/fishing rules.
- Environment/day-key characterization: per-day weather records, `tomorrowMax`, provenance, deterministic seeded fallback independent of RNG draw count, timezone/DST day keys.
- Game/diudiule session reward characterization: server-issued tokens, elapsed-game-time caps, task counters, expire/abandon/settle paths.
- For each old mutation path, seed the same RNG/time and assert the shared runtime produces the expected canonical state/events.
- Determinism property tests: same state+command/tick sequence+RNG seed+environment => identical bytes/event order; different seed or environment may differ but remains valid.
- Verify runtime modules import no DOM/Electron/Node I/O; static test for `Math.random`, `Date.now`, `new Date`, `window`, `document`, `node:*`, and external fetch.

### 16.2 Command contract and validation tests

- Every command has a handler, payload validator, authorization role, and at least one success/failure test.
- Catalog coverage test fails if a canonical `update`/`setInfo`/mutation remains outside the runtime.
- Invalid payload, no pet/dead/paused/busy, insufficient funds/item, not available, cooldown, already claimed, unauthorized, catching-up.
- Rejected commands consume no RNG and leave state/jobs/events unchanged.
- Command result shape exactly matches protocol; duplicate opId returns original result.
- Reset/adopt/bury/revive and both-empty bootstrap paths.
- API guard: no client SavePatch/tick/reward fields accepted over WS.
- Command-coverage static gate maps every canonical mutation call site (including mail delete, island quiz/options/talk/news, game/diudiule sessions, farm/fishing, SWF callbacks) to a command and migration group; no renderer/shared canonical mutation outside runtime is allowed.
- Destructive command authorization: reset/adopt/import/timezone/advance/weather-city are owner-only.

### 16.3 Server scheduler, RNG, and offline tests

- Fake wall clock + injected server clock:
  - one tick per 60s game minute;
  - daily boundary/timezone transitions, including east/west timezone changes and DST; passed new-zone boundaries are skipped, next boundary runs once;
  - scheduled work/study/travel and game/diudiule session expiry exactly once;
  - random illness/tasks/games/weather fallback reproducible from persisted seed/state/day key;
  - `advanceWhileEmpty=true`: zero clients, process running, world state advances but `onLineTime`/`onlineDataTime`/sign-in online-gift countdown do not;
  - with one authenticated client, world and session-clock effects both advance;
  - `advanceWhileEmpty=false`: zero clients freeze; reconnect no backfill; with clients active it advances and resumes;
  - server restart enabled: catch-up from anchor in bounded chunks;
  - server restart disabled: no empty catch-up;
  - local closed-app catch-up runs full world effects with `sessionActive=false`, bounded chunks, and `catching_up` status;
  - process crash between chunks/transaction rollback no duplicate ticks/rewards;
  - commands rejected during catch-up; final snapshot/ready arrives.
- Game/diudiule session tests: fabricated/replayed/wrong-device/expired/abandoned tokens, per-day cap, task-counter exactly-once, arbitrary reward field rejection, timeout cancellation.
- Portable import tests: anchor older than 48h/future skew/exact boundary, one catch-up only, repeated import/restart, engine/RNG/session/environment preservation.
- No unbounded loop: cap per chunk; event-loop yields; health reports catch-up progress.
- Event order and job ordering `(dueAtGameMs, jobId)` stable.

### 16.4 Persistence, auth, backup, and server integration tests

- SQLite migration from empty and prior schema; WAL transaction atomicity across state/RNG/jobs/commands/events.
- Unique opId/idempotency; commandStatus `applied`/`rejected`/`not_applied`; crash between commit and response; UI remains read-only until reconciliation.
- Portable bundle JSON round-trip preserves shared SaveData + engine state; SQLite schema includes game_sessions/jobs/day-boundary/environment metadata; weather records and canonical weather city persist.
- Device pairing TTL/single-use/revocation/role enforcement; token hashes; no plaintext token in DB/log.
- Backup/restore independent of command/event retention; schema/game-time checks.
- Projection/event sequence and resync after missed frames; replay retention and snapshot fallback.
- Same-seed local/server parity integration.
- WebSocket size/rate/auth/protocol-version tests.

### 16.5 Projection/hydration tests

- In-place merge preserves `save.petInfo`, `save.settings`, and `info` aliases.
- Local overlay preserved across server projections: position/UI/secrets never overwritten.
- Cache invalidation for tasks, sign-in, fishing, island, farm.
- Monotonic full projections apply even across scheduler-batch revision jumps; revision regression/schema mismatch stops and resyncs; an event-cursor gap requests replay without treating event payload as canonical state.
- Renderer direct canonical mutation is blocked/omitted.
- Shared/local settings behavior, unified `setAdvanceWhileEmpty`, canonical weather city/per-day records, and local full closed-period catch-up status.

### 16.6 Two-Electron-instance E2E (mandatory final gate)

- Start a real server with temporary SQLite WAL and a real WSS-capable local endpoint/proxy.
- Start two Electron instances with distinct `QQPET_USER_DATA` (test override `src/main/index.ts:25-26`; single-instance lock at `:39`).
- Use `tools/cdp.mjs` or a small Playwright harness to interact with both renderers.
- Scenarios:
  1. First-run adopt on an empty server; verify both clients converge.
  2. Feed on A; assert one inventory decrement/task increment and B update within latency.
  3. Start timed work on A; verify B sees the same server deadline and completion is server-generated, not client-generated.
  4. Both clients attempt actions; verify server ordering/rejections/projection convergence.
  5. Disconnect/kill A; B continues; restart/reconnect A; no duplicate command/reward.
  6. Kill all clients with `advanceWhileEmpty=true`; advance server clock or wait real minutes; reconnect and assert progression/random event.
  7. Repeat with false; assert freeze and no backfill.
  8. Restart server; verify deterministic snapshot/RNG/schedule recovery and catch-up.
  9. Verify no client direct mutation/legacy SavePatch can affect canonical state.
  10. With all clients closed and `advanceWhileEmpty=true`, verify world progression but zero `onLineTime`/`onlineDataTime`/sign-in online-gift countdown change; reconnect and verify session-clock accrual.
  11. Exercise a game/diudiule session token, duplicate/expired/wrong-device reward attempts, and task-counter exactly-once.
  12. Export a portable bundle, import it into a fresh server/local host, and verify RNG/jobs/sessions/anchor/day-boundary/environment preservation and no double catch-up.
  13. Inspect server DB/logs and projections for secrets/device fields.
- Final evidence includes hashes/revisions from both clients and server.
- Mobile local-runtime parity/build is a separate mandatory gate, not a mock.

### 16.7 Local-mode regression/parity

- LocalRepository same-runtime command sequence produces the same semantic state/events as server for fixed seed/clock/environment/session context, including weather/day keys, game sessions, and task counters.
- Local app closed with advance true fast-forwards the full world on next launch, with online counters frozen and bounded catch-up status; false freezes/no backfill.
- Portable bundle export/import round-trip preserves RNG/schedules/sessions/anchor/day-boundary/environment.
- Old bare save/config import migration, corrupt-file backup, export/import, reset.
- Android/Harmony/iOS local bridge runtime parity, native v2-file persistence, server-mode hiding, and Vite/typecheck builds.
- Local mode requires no network and does not open WebSocket.
- Two desktop instances remain single-instance per userData; local mode is one local authority.

### 16.8 CI levels

- PR runtime/unit/contract tests via `npm run test:compat` or a new `test:runtime`, plus root typecheck (`tsconfig.node`, `tsconfig.web`, `tsconfig.harmony`).
- Mobile local-runtime tests plus `npm run build:android-web`, `build:harmony-web`, and `build:ios-web` to prove the shared runtime/command/projection contract bundles in all local hosts.
- Server tests: Node 22, temp SQLite, auth/session/scheduler/command/game-session/weather/portable-import integration.
- Docker build/health/backup smoke test.
- E2E job with Linux Electron + two userData dirs; mandatory before release approval. Mobile local-runtime integration/typecheck is also mandatory.
- Tag build must not rely on the old "tests only in PR" behavior; add the sync/runtime/server/mobile gates to the release path.

## 17. Commit slicing plan

The implementation is intentionally too large for one change. This sequence is dependency-ordered; every commit must leave a coherent state, keep local mode working (unless explicitly behind a dev-only flag), and be audited with the review-agent skill.

### C1 — Shared runtime foundation, clock/RNG, day-key helpers, characterization harness

- Add `src/shared/pet-runtime/types.ts`, `rng.ts`, `time.ts`, `events.ts`, deterministic day-key/timezone helpers, weather/environment types, modular state/serialization helpers.
- Move pure deterministic primitives first: level/cap selectors, stat math, RNG, fixed tick helpers, per-day weather fallback, command/result base types.
- Add test harness that can replay current behavior with a deterministic RNG/time adapter; no production UI wiring.
- Add static checks forbidding `Math.random`, wall-clock, DOM/Node APIs in runtime.
- No user-visible behavior change.

### C2 — Command catalog, protocol, portable bundle, data-boundary and environment schemas

- Add complete `PetCommand`/payload map, command validation/error types, ordered event types, protocol message types/versioning.
- Add `SharedSaveData`, `DeviceLocalOverlay`, `PortablePetBundleV1`, EngineState persistence fields, per-day weather records/day keys, allowlist/filter validators, schema versions.
- Add tests for command payloads, shared/local boundaries, protocol shape, and secret exclusion.
- No server or renderer behavior change.

### C3 — Runtime groups A–D, online/session-clock split, game-session rewards

- Extract deterministic handlers and minute-step logic for core stats/lifecycle, inventory/economy/VIP, work/study/travel/exams/tasks, daily resets/sign-in/mail.
- Implement `activeClientCount`/`sessionActive` online-time gating, deterministic per-day weather fallback, and game/diudiule/exam session reward/abandon/cancel rules.
- Add characterization/golden tests per group and deterministic RNG/time tests.
- Add a headless runtime test that can execute commands/ticks without Electron.
- No production wiring.

### C4 — Runtime groups E–F, scheduler/timezone, full command coverage

- Extract social/island/games logic and fishing/farm rules; complete missing handlers.
- Complete command validation/event generation and scheduled jobs.
- Add scheduler/catch-up tests including `advanceWhileEmpty=true/false`, active-session online-clock split, east/west/DST timezone boundaries, RNG/restart, bounded chunks.
- Add a catalog-coverage gate over every current mutation call site and feature-parity groups A–F; fail if a canonical mutation lacks a command/runtime handler.
- No production wiring; server mode remains unavailable.

### C5 — Desktop/mobile LocalRepository, portable bundle, local v2 persistence

- Add desktop main and Android/Harmony/iOS bridge LocalRepository hosts, portable-bundle local v2 document, atomic migration from bare save data, local scheduler, command queue, projection/events contract, and per-host native file persistence.
- Keep legacy local path behind a dev-only runtime flag; never run both in one mode.
- Add local parity/characterization tests against the headless runtime.
- Local default still old until the final cutover; no server mode.

### C6 — Renderer projection/command UI (all hosts), groups A–D

- Add `window.qqpet.command`, projection/status/result events, read-only store projection, in-place hydration, local settings overlay, feature-cache invalidation.
- Convert core/inventory/jobs/tasks/daily panels to semantic commands and projection events under the runtime flag; ensure the shared renderer runs on desktop and mobile bridges without storage-mode branching.
- Remove those feature paths from renderer canonical mutation. Legacy flag off keeps old path for un-migrated groups.
- Tests for command UI, projection aliases, local settings, and no optimistic canonical writes.

### C7 — Renderer groups E–F, mobile local UI, local-mode cutover

- Convert games/social/island/fishing/farm panels to commands/projections.
- Switch desktop and mobile local mode to shared runtime by default; hide mobile server-mode UI/capability.
- Remove/guard canonical `update()`/`setInfo()`/`save(patch)` paths; ensure no client-side gameplay rule remains.
- Delete legacy renderer mutation adapters used during migration.
- Add local full closed-period catch-up/migration UX/perf handling, mobile local parity/build tests. No server mode yet.

### C8 — Server package, persistence/auth/session, game sessions, command service

- Add `server/` package, SQLite migrations/transactions (including game_sessions), device registry/pairing/auth, WebSocket sessions, command service/idempotency, snapshot/event storage, weather cache/CLI/config, health/logging.
- Launch the shared runtime host with persisted schedule/RNG and `advanceWhileEmpty` setting; implement server command handlers from the same shared runtime.
- Add server integration tests for auth, command duplicate/status, transaction rollback, persistence, backups.
- Server is runnable/testable but not exposed to the desktop app yet.

### C9 — Server scheduler, advanceWhileEmpty/online-clock split, catch-up, restart, portable import

- Implement 60s scheduler, wall anchor, `advanceWhileEmpty` enable/disable, active-client/session clock split, bounded catch-up chunks, timezone/DST boundary handling, command gating, recovery after crash/restart, RNG/job/session persistence, portable-import anchor clamp, projection/event broadcast.
- Add fake-clock tests for enabled/disabled zero-client behavior, restart determinism, no duplicate rewards, backup/restore.
- Health/metrics for game time/catch-up/next tick/scheduled jobs.

### C10 — RemoteRepository WebSocket integration (desktop only)

- Add RemoteRepository WSS client, pairing/token safeStorage, reconnect/backoff, cursor, snapshot/replay/resync, command in-flight status, local projection cache, status events.
- Add server-mode feature flag and integration tests: two WebSocket clients, feed/projection, lost result, duplicate opId, revision gap.
- No storage UI yet; used in tests/dev builds.

### C11 — Storage UI, portable import/export, mode switching, weather/timezone, backups, admin flows

- Add storage admin UI: mode choice, server URL/pairing, status/revision/gameTime, unified `setAdvanceWhileEmpty`, timezone, canonical weather city, initial source, switch back to local.
- Add portable-bundle export/import UI and backup/clamp reporting, local v1→v2 migration, server first-enable upload/use-server choice, reset/adopt owner commands, admin replacement.
- Remove server-mode feature flag; enable both modes.
- Test migration failures/rollback, secret/local-field denial, backup before overwrite.

### C12 — E2E (desktop + mobile local), CI, deployment docs, and final gate

- Add two-Electron-instance real-server E2E plus mobile bridge/local-runtime parity and build checks.
- Add CI runtime/command/server/scheduler/E2E jobs and release gating.
- Complete server `README`, Docker Compose, Caddy/Nginx TLS/WebSocket docs, systemd unit, backup/restore and runbook.
- Run full acceptance matrix; record evidence before human/Lead sign-off.

Each commit gets a review-agent audit; no commit is merged on unresolved P0/P1 findings.

## 18. Quality gates and delivery process

### 18.1 Design builder-check (before implementation)

A fresh senior implementer/architect must read this spec and the cited code, then return a checklist proving:

- D1 is fully resolved to server-side game engine; no lease/delegated path remains.
- The shared runtime is pure/deterministic and its state/event shapes are implementable.
- Every current canonical mutation has a command/catalog mapping or an explicitly flagged migration risk.
- LocalRepository uses the same runtime on desktop and mobile local hosts and has a viable portable-bundle/v2 persistence/migration path; server mode is hidden on mobile.
- Full feature parity and the command-coverage gate cover every canonical mutation/current call site, including farm/fishing/island/games/mail/sign-in/jobs/travel/shop-inventory.
- Server command ordering/idempotency/event sequence/scheduler/catch-up/reconnect/status (`applied`/`rejected`/`not_applied`) semantics are testable.
- `advanceWhileEmpty` true/false, online-session clock split, local full closed-period catch-up, and restart behavior are unambiguous.
- Canonical weather model (owner city, per-day records/provenance/fallback/day key) and timezone/DST boundary changes are implementable/testable.
- Game/diudiule/exam session tokens, caps, expiry/abandonment, task-counter integration, and exploit tests are complete.
- Portable bundle export/import preserves engine state and bounded anchor clamp/no double catch-up.
- Shared/device/never-upload boundaries and secret hygiene are complete.
- Backups are independent of log retention.
- Commit slices have no missing dependency and each leaves a coherent state.
- The final E2E/test matrix is achievable.

The Lead reviews the builder-check, then the human explicitly approves the spec and the shared-settings/default decisions. No product code begins before this gate.

### 18.2 Review-agent audit for every commit

Every implementation commit is audited with the read-only review-agent skill:

`~/.codex/skills/.system/review-agent/SKILL.md`

The audit must:

- read applicable `AGENTS.md` instructions;
- inspect the complete diff plus surrounding call sites/tests;
- report only concrete correctness/security/performance/maintainability regressions introduced by that commit;
- present findings first, ordered `[P0]`–`[P3]` with `path:line`;
- end with an overall assessment and material test gaps/residual risks;
- say `No findings.` when none qualify, without inventing style nits.

P0/P1 findings block the commit. P2/P3 findings must be fixed or explicitly accepted by the Lead with rationale; fixes are re-audited.

### 18.3 Final release gate

- All acceptance criteria in §15 pass.
- The two-Electron-instance E2E has run against a real server, not a mock.
- Android/Harmony/iOS local runtime/build checks and local/server parity pass; server mode remains hidden on mobile.
- Feature parity and command-coverage gates pass for all in-scope features.
- Online-time/session-clock split, weather/day-key/fallback, game-session exploit suite, timezone/DST changes, portable bundle round-trip, anchor clamp, and backup restore are demonstrated.
- Local full closed-period catch-up is implemented with progress/read-only UX and matches server world semantics.
- No client patch/tick/reward path can mutate canonical state.
- No secrets/device fields are found in server DB/broadcast/log/backups; active session tokens are device-bound and not reusable across devices/hosts.
- Human approval is recorded for the final scope and defaults.

## 19. Scope risks and resolved builder-check questions

### 19.1 Resolved previous builder-check questions

1. **Lease ambiguity — resolved.** There is no lease. The server is the only authority in server mode.
2. **Stale in-flight command/idempotency — resolved.** `opId` + command log + `commandStatus` (`applied`/`rejected`/`not_applied`); no blind resend, no offline command queue; UI stays frozen/read-only until reconciliation, then `not_applied` requires explicit retry with a fresh opId.
3. **Reset/adopt ambiguity — resolved.** `pet.reset` and `pet.adopt` are explicit server commands with canonical validation; no payload-free admin replacement.
4. **Both sides empty — resolved.** Server starts a canonical empty SaveData and shows egg adoption; `pet.adopt` creates the pet.
5. **Shared settings allowlist — resolved for MVP:** `paused`, `difficulty`, `undying`; all other settings are device-local. Human may amend the list before approval.
6. **Backups independent of op-log retention — resolved.** SQLite online backups in a separate backup directory; retention/restore rules in §9.6/§12.4.
7. **Weather inputs — resolved.** Per-game-day `WeatherDayRecord` keyed by canonical timezone/day key, owner-configured canonical city, persisted forecasts/provenance, and deterministic seeded fallback; client `weatherCity` is local-only.
8. **Online-time vs zero clients — resolved.** Game-world ticks and session-clock online rewards are separate; `RuntimeContext` carries `activeClientCount`/`sessionActive`.
9. **Local `advanceWhileEmpty` control — resolved.** Unified `setAdvanceWhileEmpty` repository/API/UI capability; local persisted policy and server owner command.
10. **Game/diudiule sessions — resolved.** Server-issued one-use tokens, `game.reward`/`diudiule.reward`, caps, expiry/abandonment, task-counter rules, and exploit tests.
11. **Portable engine-state migration — resolved.** `PortablePetBundleV1` carries shared SaveData + engine state; bounded anchor clamp and no double catch-up on import/detach.
12. **Timezone changes — resolved.** `lastProcessedDayBoundaryKey`/`nextDayBoundaryGameMs`; new-zone passed boundaries are skipped and the next 06:00 boundary runs once.
13. **Mobile local runtime — resolved.** Mobile bridges host LocalRepository/shared runtime; server mode is hidden; same command/projection contract.
14. **Catalog completeness — resolved by normative command catalog + static coverage gate.** Farm/fishing/island/small games/mail/sign-in/jobs/travel/shop-inventory are all in scope.

### 19.2 Key scope risks

- **Farm/fishing extraction is the highest risk.** Current farm behavior lives partly in `Farm.swf` and localStorage; fishing uses SWF/TypeScript module caches. Full server-side rules require reimplementation/characterization, not merely moving a function. This must be visibly estimated and tested.
- **Island/community prose and position are mixed with canonical state.** AI-generated strings, day planning, and walk position currently share `saveJsonData`. Canonical IDs/counters/outcomes must be represented in runtime state; prose/position may be local presentation. The feature cannot be hidden in server mode as a workaround; inability to separate it is a release blocker/escalation.
- **Command-catalog completeness.** The current UI has many direct mutation call sites and feature-specific state. A static coverage gate plus characterization tests are required; “looks migrated” is not enough.
- **Local-mode behavior change.** Running the same full runtime locally while the app is closed changes when hunger/growth/random events advance compared with today’s renderer-only behavior. The default `advanceWhileEmpty=true` preserves the offline-progress promise but changes the exact shape of offline progression; it must be explicitly approved and documented.
- **Renderer/SWF coupling.** Animations, speech, input, moderation of AI text, and local UI currently call mutating functions. The command/projection migration is broad and can regress UX timing even if state becomes correct.
- **Canonical weather/day-key modeling.** Server weather requires owner city configuration, per-day fetch/cache/provenance, deterministic fallback, and timezone/DST day-key handling. A bug here makes illness/random events non-reproducible.
- **Online-time/session split.** The server must not accrue `onLineTime`, `onlineDataTime`, or sign-in online-gift countdown during empty enabled intervals or local closed-app catch-up; putting those in the world tick would silently grant session rewards while nobody is online.
- **Mobile local-runtime hosting.** Android/Harmony/iOS bridges must share the runtime and command/projection contract without server-mode code. Native lifecycle/suspension, file atomicity, Vite bundling, and typecheck coverage are real portability risks.
- **Local full closed-period progression.** The approved local behavior now simulates hunger, growth, illness, random events, death, tasks, jobs, farm/fishing, etc. across the full app-closed period. This is a deliberate behavior change with UX/performance implications: large catch-up must yield, show progress, and stay read-only until ready.
- **Portable bundle/anchor correctness.** Engine-state import must preserve RNG/schedules/sessions/environment/day-boundary state while clamping anchors and avoiding double catch-up; malformed or stale bundles can corrupt future progression.
- **Game-session exploit surface.** Token issuance, device binding, expiry, caps, abandoned sessions, task counters, and command idempotency all need adversarial tests; accepting client reward amounts would break server authority.
- **Deterministic external inputs/AI.** Calendar/weather and AI output are not naturally deterministic. The runtime must receive persisted normalized environment inputs and keep prose/presentation out of canonical state; otherwise restart/replay reproducibility is impossible.
- **Long catch-up.** Enabled zero-client operation can create large wall-time gaps. Bounded chunks, readiness gating, health visibility, and test coverage are required; an unbounded catch-up loop can freeze the server.
- **Full projection size/event volume.** Full SaveData projections are simple and safe but may grow with farm/island/album state. Limits, retention, and possibly snapshot compression must be designed if payload sizes approach caps.
- **Server always-on.** `advanceWhileEmpty=true` only works while the service runs. Docker/systemd restart policies, health checks, and operators must understand that server downtime is recovered by catch-up only when enabled.
- **No anti-cheat.** Paired devices are trusted for gameplay commands; server validation is rule/authority validation, not an adversarial cheat-proof client. This is acceptable for self-hosted single-household deployment and remains out of scope.

### 19.3 Implementation defaults requiring confirmation at approval

These are not open architectural alternatives; they are concrete defaults in this spec:

- `advanceWhileEmpty` default `true` for both server and local mode.
- Shared settings: `paused`, `difficulty`, `undying`.
- Server tick 60s, scheduler poll 1s, catch-up chunk 1,440 ticks.
- Default timezone: resolved host IANA zone at pet creation, or explicit `QQPET_SYNC_TIME_ZONE`.
- Command/event retention 10,000 entries or 30 days for reconciliation/audit; backups retained separately.
- E2E latency target p95 ≤ 1s LAN/loopback (CI timeout 3s).
- Canonical weather city configured by operator/owner; missing forecasts use deterministic seeded fallback and `provenance:'fallback'`.
- Game session timeouts: small/flash 60 minutes, diudiule 5 minutes, exam 30 minutes of game time; `game.reward` daily `Game` cap 60 minutes, `diudiule.reward` no GameRound/Game increment.
- Import anchor clamp: 48h into the past, 5m into the future; at most one startup catch-up.
- Day key: `YYYY-MM-DD` of the 06:00 boundary in the canonical IANA timezone.

## 20. Definition of done for this design

This design artifact is complete for approval when:

- The human confirms the full server-side engine and local/shared-runtime migration on desktop and mobile local hosts.
- The shared settings allowlist, canonical weather city/fallback policy, and `advanceWhileEmpty` default are accepted.
- Feature parity and the command-coverage gate are accepted as release conditions.
- The builder-check reports no unresolved architecture contradiction.
- The Lead approves the C1–C12 slicing and final E2E gate.
- Implementation has still not begun.

Implementation begins only after approval and follows the per-commit review-agent gate.
