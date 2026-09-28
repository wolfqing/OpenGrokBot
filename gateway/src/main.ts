import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import Docker from 'dockerode'
import { parseA2AAllow } from './a2a.js'
import { loadOrCreateToken, trustedOrigins } from './auth.js'
import { loadConfig } from './config.js'
import { runningBotIds, stopBotContainer } from './containers.js'
import { openDb } from './db.js'
import { createLLM } from './llm.js'
import { createPool, reapIdleComputers } from './pool.js'
import { listRoutines } from './routines.js'
import { createScheduler, type Scheduler } from './scheduler.js'
import { seedGroup, seedTeammates } from './seed.js'
import { createApp } from './server.js'
import { serveWeb } from './web.js'

const config = loadConfig()
mkdirSync(config.dataDir, { recursive: true })
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })
const db = openDb(config.dbPath)
// 预置样板来自版本库，用户新雇的同事住在数据目录
const bots = [
  ...seedTeammates(db, config.teammatesDir),
  ...seedTeammates(db, join(config.dataDir, 'teammates')),
]
seedGroup(db, { id: config.groupId, title: config.groupTitle, memberIds: bots })
const llm = createLLM(config)
const docker = new Docker()
const pool = createPool({
  dataDir: config.dataDir,
  docker,
  containerOptions: { memoryMb: config.botMemoryMb, cpus: config.botCpus, timeZone: config.timeZone },
})
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

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
app.get('/ws', upgradeWebSocket(() => ({
  onOpen: (_evt, ws) => {
    hub.add(ws)
    ws.send(JSON.stringify(gateway.hello()))
  },
  onClose: (_evt, ws) => hub.remove(ws),
})))

// pnpm build 之后网关直接托管前端：一个端口、一个进程；dev 下前端走 Vite（5173）
const servingWeb = serveWeb(app, config.webDist)

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
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
injectWebSocket(server)

// 空闲的电脑停机省内存；登录态和文件都在 workspace 里，下次用时原样拉起
if (config.idleStopMinutes > 0) {
  const startedAt = Date.now()
  const timer = setInterval(() => {
    reapIdleComputers({
      pool,
      idleMs: config.idleStopMinutes * 60_000,
      runningBots: () => runningBotIds(docker),
      isBusy: gateway.isBusy,
      stop: (botId) => stopBotContainer(docker, botId),
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
