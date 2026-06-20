// Worker principal — roda no VPS Vortexus.
// Sprint 6: gestão de sockets Baileys (1 por conta).
// Sprint 8: scheduler de notificações + workers WhatsApp e E-mail.

import 'dotenv/config'
import pino from 'pino'
import { createAdminClient } from './supabase.js'
import { BaileysManager } from './baileys-manager.js'
import { runScheduler } from './scheduler.js'
import { processarFilaWhatsApp } from './workers/whatsapp-worker.js'
import { processarFilaEmail } from './workers/email-worker.js'
import { sleep } from './format.js'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' })

// Intervalos de polling
const SCHEDULER_INTERVAL_MS  = 60 * 60 * 1000   // 1h entre execuções do scheduler
const WA_POLL_INTERVAL_MS    = 15_000            // 15s entre ciclos do worker WA
const EMAIL_POLL_INTERVAL_MS = 15_000            // 15s entre ciclos do worker e-mail

async function main() {
  logger.info('Quita Worker iniciando...')

  const supabase = createAdminClient()
  const manager  = new BaileysManager(supabase)

  // ── Baileys: restaurar sessões ──────────────────────────────────────────────
  logger.info('Restaurando sessões Baileys...')
  await manager.restaurarSessoes()

  // ── Realtime: receber comandos de conexão ───────────────────────────────────
  supabase
    .channel('worker-comandos')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conexoes' }, async (payload) => {
      const { conta_id, comando } = payload.new as { conta_id: string; comando: string | null }
      if (!comando) return
      logger.info({ conta_id, comando }, 'Comando de conexão recebido')
      try {
        if (comando === 'reconectar') await manager.reconectar(conta_id)
        else if (comando === 'desconectar') await manager.desconectar(conta_id)
      } catch (err) {
        logger.error({ conta_id, err }, 'Erro ao processar comando de conexão')
        await supabase.from('conexoes').update({ comando: null }).eq('conta_id', conta_id)
      }
    })
    .subscribe()

  // ── Scheduler: executar imediatamente e depois a cada 1h ───────────────────
  const executarScheduler = async () => {
    try { await runScheduler(supabase) }
    catch (err) { logger.error({ err }, 'Scheduler: erro') }
  }

  await executarScheduler()
  setInterval(executarScheduler, SCHEDULER_INTERVAL_MS)

  // ── Worker WhatsApp: polling a cada 15s ─────────────────────────────────────
  const loopWhatsApp = async () => {
    while (true) {
      try { await processarFilaWhatsApp(supabase, manager) }
      catch (err) { logger.error({ err }, 'Worker WA: erro') }
      await sleep(WA_POLL_INTERVAL_MS)
    }
  }

  // ── Worker E-mail: polling a cada 15s ───────────────────────────────────────
  const loopEmail = async () => {
    while (true) {
      try { await processarFilaEmail(supabase) }
      catch (err) { logger.error({ err }, 'Worker E-mail: erro') }
      await sleep(EMAIL_POLL_INTERVAL_MS)
    }
  }

  loopWhatsApp()
  loopEmail()

  logger.info('Worker pronto.')

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { logger.info(`${signal} — encerrando.`); process.exit(0) })
  }
}

main().catch(err => { console.error('Worker falhou:', err); process.exit(1) })
