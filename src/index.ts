// Worker principal — roda no VPS Vortexus.
// Sprint 6: gestão de sockets Baileys (1 por conta).
// Sprint 8: scheduler de notificações + workers WhatsApp e E-mail.

import 'dotenv/config'
import { createServer } from 'http'
import pino from 'pino'
import { createAdminClient } from './supabase.js'
import { BaileysManager } from './baileys-manager.js'
import { runScheduler } from './scheduler.js'
import { processarFilaWhatsApp, processarFilaImediata } from './workers/whatsapp-worker.js'
import { processarFilaEmail } from './workers/email-worker.js'
import { sleep } from './format.js'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' })

// Intervalos de polling
const SCHEDULER_INTERVAL_MS  = 60 * 60 * 1000   // 1h entre execuções do scheduler
const WA_POLL_INTERVAL_MS    = 15_000            // 15s entre ciclos do worker WA
const WA_IMEDIATO_INTERVAL_MS = 3_000            // 3s — pagamento_confirmado e boasvindas
const EMAIL_POLL_INTERVAL_MS = 15_000            // 15s entre ciclos do worker e-mail
const CMD_POLL_INTERVAL_MS   = 10_000            // 10s entre verificações de comandos pendentes

async function main() {
  logger.info('Cobranx Worker iniciando...')

  const supabase = createAdminClient()
  const manager  = new BaileysManager(supabase)

  // ── Startup: limpar estados inconsistentes ─────────────────────────────────
  // 'conectando' sem sessão real → desconectado; comandos stale → limpar
  await supabase.from('conexoes')
    .update({ status: 'desconectado', qr_code: null, comando: null })
    .eq('status', 'conectando')
  await supabase.from('conexoes')
    .update({ comando: null })
    .not('comando', 'is', null)

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
      } finally {
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

  // ── Polling de comandos: fallback para quando o Realtime falha ────────────────
  const loopComandos = async () => {
    while (true) {
      await sleep(CMD_POLL_INTERVAL_MS)
      try {
        const { data: pendentes } = await supabase
          .from('conexoes')
          .select('conta_id, comando')
          .not('comando', 'is', null)

        for (const row of pendentes ?? []) {
          const contaId = row.conta_id as string
          const comando = row.comando as string
          logger.info({ contaId, comando }, 'Comando detectado via polling')
          try {
            if (comando === 'reconectar') await manager.reconectar(contaId)
            else if (comando === 'desconectar') await manager.desconectar(contaId)
          } catch (err) {
            logger.error({ contaId, err }, 'Erro ao processar comando (polling)')
          } finally {
            await supabase.from('conexoes').update({ comando: null }).eq('conta_id', contaId)
          }
        }
      } catch (err) {
        logger.error({ err }, 'Polling de comandos: erro')
      }
    }
  }

  // ── Worker WhatsApp: polling a cada 15s (lembretes regulares) ───────────────
  const loopWhatsApp = async () => {
    while (true) {
      try { await processarFilaWhatsApp(supabase, manager) }
      catch (err) { logger.error({ err }, 'Worker WA: erro') }
      await sleep(WA_POLL_INTERVAL_MS)
    }
  }

  // ── Worker imediato: pagamento_confirmado + boasvindas a cada 3s ─────────────
  const loopImediato = async () => {
    while (true) {
      try { await processarFilaImediata(supabase, manager) }
      catch (err) { logger.error({ err }, 'Worker imediato: erro') }
      await sleep(WA_IMEDIATO_INTERVAL_MS)
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

  loopComandos()
  loopWhatsApp()
  loopImediato()
  loopEmail()

  // ── Health check HTTP ───────────────────────────────────────────────────────
  const healthPort = parseInt(process.env.HEALTH_PORT ?? '3001')
  createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status:            'ok',
        contas_conectadas: manager.contasConectadas(),
        uptime_s:          Math.floor(process.uptime()),
      }))
    } else {
      res.writeHead(404)
      res.end()
    }
  }).listen(healthPort)

  logger.info({ healthPort }, 'Worker pronto.')

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { logger.info(`${signal} — encerrando.`); process.exit(0) })
  }
}

main().catch(err => { console.error('Worker falhou:', err); process.exit(1) })
