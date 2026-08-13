import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import Docker from 'dockerode'
import { parseA2AAllow } from './a2a.js'
import { runTurn } from './agent.js'
import { loadConfig } from './config.js'
import { openDb, type BotRow } from './db.js'
import { createLLM } from './llm.js'
import { readMemory } from './memory.js'
import { createPool } from './pool.js'
import { listRoutines, markRoutineRun } from './routines.js'
import { saveScreenshot } from './screenshots.js'
import { createScheduler, type Scheduler } from './scheduler.js'
import { seedGroup, seedTeammates } from './seed.js'
import { createApp } from './server.js'

const config = loadConfig()
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })
const db = openDb(config.dbPath)
// 预置样板来自版本库，用户新雇的同事住在数据目录
const bots = [
  ...seedTeammates(db, config.teammatesDir),
  ...seedTeammates(db, join(config.dataDir, 'teammates')),
]
seedGroup(db, { id: config.groupId, title: config.groupTitle, memberIds: bots })
const llm = createLLM(config)
const pool = createPool({ dataDir: config.dataDir, docker: new Docker() })

// scheduler 的触发回调要用 hub 广播，而 hub 由 createApp 产出——用一个盒子打破这个先有鸡还是先有蛋
const schedulerBox: { current?: Scheduler } = {}
const schedulerProxy: Scheduler = {
  add: (r) => schedulerBox.current?.add(r),
  load: (rs) => schedulerBox.current?.load(rs),
  stopAll: () => schedulerBox.current?.stopAll(),
  size: () => schedulerBox.current?.size() ?? 0,
}

const { app, hub } = createApp({
  db, llm, pool, dataDir: config.dataDir, scheduler: schedulerProxy,
  chiefId: config.chiefId,
  a2aRules: parseA2AAllow(config.a2aAllow, config.chiefId),
})

schedulerBox.current = createScheduler({
  run: async (routine) => {
    const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(routine.bot_id) as BotRow | undefined
    if (!bot) return
    const threadId = `dm:${bot.id}`
    let soul = ''
    try { soul = bot.soul_path ? readFileSync(bot.soul_path, 'utf8') : '' } catch { /* soul 缺失可运行 */ }
    markRoutineRun(db, routine.id, Date.now())
    await runTurn(
      {
        db, llm, bot, soul, threadId,
        memory: await readMemory(config.dataDir, bot.id),
        getComputer: () => pool.get(bot.id),
        saveShot: (botId, shot) => saveScreenshot(config.dataDir, botId, shot, Date.now()),
      },
      `Your routine "${routine.name}" just fired. Do this now: ${routine.instructions}`,
      {
        onMessage: (m) => hub.broadcast({ type: 'message', threadId, message: m }),
        onStatus: (botId, state) => hub.broadcast({ type: 'status', botId, state }),
      },
      { persistUserMessage: false }, // routine 触发不该在线程里冒出一条假的用户消息
    )
  },
})
schedulerBox.current.load(listRoutines(db))

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
app.get('/ws', upgradeWebSocket(() => ({
  onOpen: (_evt, ws) => hub.add(ws),
  onClose: (_evt, ws) => hub.remove(ws),
})))

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `[gateway] http://localhost:${info.port} · model=${config.model}` +
    ` · bots: ${bots.join(', ') || '(none)'} · routines: ${schedulerProxy.size()}`,
  )
})
injectWebSocket(server)

// bot 的电脑该长期在线：退出只断 CDP 连接，容器留着（也保住浏览器登录态）
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    schedulerProxy.stopAll()
    void pool.disposeAll().finally(() => process.exit(0))
  })
}
