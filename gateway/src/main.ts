import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { createLLM } from './llm.js'
import { seedTeammates } from './seed.js'
import { createApp } from './server.js'

const config = loadConfig()
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })
const db = openDb(config.dbPath)
const bots = seedTeammates(db, config.teammatesDir)
const llm = createLLM(config)
const { app, hub } = createApp({ db, llm })

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
app.get('/ws', upgradeWebSocket(() => ({
  onOpen: (_evt, ws) => hub.add(ws),
  onClose: (_evt, ws) => hub.remove(ws),
})))

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[gateway] http://localhost:${info.port} · model=${config.model} · bots: ${bots.join(', ') || '(none)'}`)
})
injectWebSocket(server)
