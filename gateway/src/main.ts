import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { serve, upgradeWebSocket } from '@hono/node-server'
import Docker from 'dockerode'
import { WebSocketServer } from 'ws'
import { parseA2AAllow } from './a2a.js'
import { pruneActions } from './actions.js'
import { loadOrCreateToken, trustedOrigins } from './auth.js'
import { chooseBackend, createDockerBackend, dockerReachable } from './backend.js'
import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { createLLM } from './llm.js'
import { migrateLegacyMemories } from './memory.js'
import { createPool, reapIdleComputers } from './pool.js'
import { listRoutines } from './routines.js'
import { createScreenViewers, mountScreenProxy, screenRelay } from './screen.js'
import { createScheduler, type Scheduler } from './scheduler.js'
import { seedGroup, seedTeammates } from './seed.js'
import { createApp } from './server.js'
import { serveWeb } from './web.js'

const config = loadConfig()
mkdirSync(config.dataDir, { recursive: true })
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })
const db = openDb(config.dbPath, {
  onBackup: (file) => console.log(`[gateway] backed up the database before upgrading it → ${file}`),
  onMigrate: (from, to) => console.log(`[gateway] database schema v${from} → v${to}`),
})
// 预置样板来自版本库，用户新雇的同事住在数据目录
const bots = [
  ...seedTeammates(db, config.teammatesDir),
  ...seedTeammates(db, join(config.dataDir, 'teammates')),
]
seedGroup(db, { id: config.groupId, title: config.groupTitle, memberIds: bots })
const movedMemories = await migrateLegacyMemories(config.dataDir, bots)
if (movedMemories.length) console.log(`[gateway] moved MEMORY.md out of the workspaces of: ${movedMemories.join(', ')}`)
const llm = createLLM(config)
// 同事的电脑是什么做的：有 Docker 用容器，没有就用本机模式（本机后端随 M6 的 B 片接进来）
const docker = new Docker()
const { backend, reason: backendReason } = await chooseBackend(config.computers, {
  docker: () => createDockerBackend(docker, {
    dataDir: config.dataDir,
    containerOptions: { memoryMb: config.botMemoryMb, cpus: config.botCpus, timeZone: config.timeZone },
  }),
  local: () => null,
  dockerReachable: () => dockerReachable(docker),
})
console.log(`[gateway] bot computers: ${backend.kind} (${backendReason})`)
const pool = createPool({ dataDir: config.dataDir, backend })
// 令牌放在数据目录（0600），不在任何 bot 的 workspace 里：容器里的 bot 拿不到它
const token = loadOrCreateToken(config.dataDir, config.token)

// scheduler 的触发回调要用 createApp 产出的 runRoutine——用一个盒子打破这个先有鸡还是先有蛋
const schedulerBox: { current?: Scheduler } = {}
const schedulerProxy: Scheduler = {
  add: (r) => schedulerBox.current?.add(r),
  remove: (id) => schedulerBox.current?.remove(id),
  load: (rs) => schedulerBox.current?.load(rs),
  stopAll: () => schedulerBox.current?.stopAll(),
  size: () => schedulerBox.current?.size() ?? 0,
}

const gateway = createApp({
  db, llm, pool, dataDir: config.dataDir, scheduler: schedulerProxy,
  chiefId: config.chiefId,
  a2aRules: parseA2AAllow(config.a2aAllow, config.chiefId),
  token,
  allowedOrigins: trustedOrigins(config),
  dailyTokens: config.dailyTokens,
  vision: config.vision,
  timeZone: config.timeZone,
  maxSteps: config.maxSteps,
  turnMinutes: config.turnMinutes,
})
const { app, hub } = gateway

schedulerBox.current = createScheduler({
  run: async (routine) => {
    const outcome = await gateway.runRoutine(routine)
    if (outcome === 'skipped') {
      console.log(`[gateway] routine #${routine.id} "${routine.name}" is still running — skipped this firing`)
    }
  },
})
schedulerBox.current.load(listRoutines(db))

// 动作日志留 90 天：启动时清一次，之后每天清一次
const ACTION_LOG_DAYS = 90
const pruneOldActions = () => {
  const removed = pruneActions(db, Date.now() - ACTION_LOG_DAYS * 24 * 60 * 60_000)
  if (removed) console.log(`[gateway] dropped ${removed} action-log entries older than ${ACTION_LOG_DAYS} days`)
}
pruneOldActions()
setInterval(pruneOldActions, 24 * 60 * 60_000).unref()

// WebSocket 用 node-server 自带的支持：升级请求照样先过 app（令牌、来源检查都在），二进制帧交成 ArrayBuffer
app.get('/ws', upgradeWebSocket(() => ({
  onOpen: (_evt, ws) => {
    hub.add(ws)
    ws.send(JSON.stringify(gateway.hello()))
  },
  onClose: (_evt, ws) => hub.remove(ws),
})))

// 屏幕：noVNC 页面和它的 WebSocket 都经网关转发——同源、同一个登录，一条隧道就能远程接管
const knownBot = (botId: string) => Boolean(db.prepare('SELECT 1 FROM bots WHERE id = ?').get(botId))
const viewers = createScreenViewers()
app.get('/vnc/:botId/websockify', upgradeWebSocket(async (c) => {
  const botId = c.req.param('botId') ?? ''
  if (!knownBot(botId)) throw new Error(`unknown bot ${botId}`)
  const screen = (await pool.get(botId)).screen
  if (!screen) throw new Error(`${botId} has no screen`)
  return screenRelay(`${screen.base.replace(/^http/, 'ws')}/websockify`, {
    onOpen: () => viewers.open(botId),
    onClose: () => viewers.close(botId),
  })
}))
mountScreenProxy(app, { knownBot })

// pnpm build 之后网关直接托管前端：一个端口、一个进程；dev 下前端走 Vite（5173）
const servingWeb = serveWeb(app, config.webDist)

serve({
  fetch: app.fetch,
  port: config.port,
  hostname: config.host,
  websocket: { server: new WebSocketServer({ noServer: true }) },
}, (info) => {
  const base = config.webUrl || `http://localhost:${info.port}`
  console.log(
    `[gateway] listening on ${config.host}:${info.port} · model=${config.model}` +
    ` · bots: ${bots.join(', ') || '(none)'} · routines: ${schedulerProxy.size()}` +
    (servingWeb ? ' · serving the built UI' : ''),
  )
  // 常驻服务的日志可能落盘，设了 OPENGROKBOT_QUIET_TOKEN 就不把令牌写进日志
  if (process.env.OPENGROKBOT_QUIET_TOKEN) {
    console.log(`[gateway] sign in → ${base}/auth?token=<the token in ${join(config.dataDir, 'auth-token')}>`)
  } else {
    console.log(`[gateway] sign in → ${base}/auth?token=${token}`)
  }
})

// 空闲的电脑停机省内存；登录态和文件都在 workspace 里，下次用时原样拉起
if (config.idleStopMinutes > 0) {
  const startedAt = Date.now()
  const timer = setInterval(() => {
    reapIdleComputers({
      pool,
      idleMs: config.idleStopMinutes * 60_000,
      runningBots: () => backend.running(),
      isBusy: (botId) => gateway.isBusy(botId) || viewers.watching(botId),
      stop: (botId) => backend.stop(botId),
      now: Date.now(),
      startedAt,
    })
      .then((reaped) => { if (reaped.length) console.log(`[gateway] stopped idle computers: ${reaped.join(', ')}`) })
      .catch(() => { /* 没开 Docker 就没有电脑可回收 */ })
  }, 60_000)
  timer.unref()
}

// bot 的电脑该长期在线：退出只断 CDP 连接，容器留着（也保住浏览器登录态）
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    schedulerProxy.stopAll()
    void pool.disposeAll().finally(() => process.exit(0))
  })
}
