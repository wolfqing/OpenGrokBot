import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import Docker from 'dockerode'
import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { createLLM } from './llm.js'
import { createPool } from './pool.js'
import { seedTeammates } from './seed.js'
import { createApp } from './server.js'

const config = loadConfig()
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })
const db = openDb(config.dbPath)
const bots = seedTeammates(db, config.teammatesDir)
const llm = createLLM(config)
const pool = createPool({ dataDir: config.dataDir, docker: new Docker() })
const { app, hub } = createApp({ db, llm, pool, dataDir: config.dataDir })

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
app.get('/ws', upgradeWebSocket(() => ({
  onOpen: (_evt, ws) => hub.add(ws),
  onClose: (_evt, ws) => hub.remove(ws),
})))

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[gateway] http://localhost:${info.port} · model=${config.model} · bots: ${bots.join(', ') || '(none)'}`)
})
injectWebSocket(server)

// bot 的电脑该长期在线：退出只断 CDP 连接，容器留着（也保住浏览器登录态）
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void pool.disposeAll().finally(() => process.exit(0))
  })
}
