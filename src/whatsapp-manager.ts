// Gerenciador WhatsApp Web — 1 client por conta (tenant).
// Usa whatsapp-web.js (Puppeteer + WhatsApp Web real) em vez de Baileys.
// Regras anti-ban mantidas: intervalo 45–80s, janela 09–20h, fila um-a-um.
// ⚠️ Nunca rodar em serverless/Vercel — exclusivo para VPS.

import wwebjs from 'whatsapp-web.js'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Client, LocalAuth } = wwebjs as any
type WWebClient = InstanceType<typeof wwebjs.Client>
import pino from 'pino'
import path from 'path'
import fs from 'fs/promises'
import { sleep } from './format.js'
import type { SupabaseAdmin } from './supabase.js'

const SESSIONS_DIR = process.env.SESSIONS_DIR ?? '/opt/quita/sessions'
const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' })

// Warmup após reconectar — aguarda sessão estabilizar antes de liberar envios
const WARMUP_MS = 30_000

export class WhatsAppManager {
  private clients      = new Map<string, WWebClient>()
  private prontoEm     = new Map<string, number>()
  private tentativas   = new Map<string, number>()
  private foiConectado = new Map<string, boolean>()

  constructor(private supabase: SupabaseAdmin) {}

  // ── Restaurar sessões na inicialização do worker ────────────────────────────
  async restaurarSessoes() {
    const { data } = await this.supabase
      .from('conexoes')
      .select('conta_id, status')
      .eq('status', 'conectado')

    for (const row of data ?? []) {
      const contaId = row.conta_id as string
      try { await this.conectar(contaId) }
      catch (err) { logger.error({ contaId, err }, 'Erro ao restaurar sessão') }
    }
  }

  // ── Conectar (ou reconectar) uma conta ─────────────────────────────────────
  async conectar(contaId: string) {
    if (this.clients.has(contaId)) {
      await this.encerrarCliente(contaId)
    }

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: contaId,
        dataPath:  SESSIONS_DIR,
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--single-process',
        ],
      },
    })

    this.clients.set(contaId, client)

    client.on('qr', async (qr: string) => {
      logger.info({ contaId }, 'QR gerado')
      await this.supabase.from('conexoes').upsert(
        { conta_id: contaId, status: 'conectando', qr_code: qr, comando: null },
        { onConflict: 'conta_id' },
      )
    })

    client.on('ready', async () => {
      const info = client.info
      logger.info({ contaId, numero: info?.wid?.user }, 'Conectado')
      this.foiConectado.set(contaId, true)
      this.tentativas.delete(contaId)
      this.prontoEm.set(contaId, Date.now() + WARMUP_MS)

      await this.supabase.from('conexoes').upsert(
        {
          conta_id:         contaId,
          status:           'conectado',
          qr_code:          null,
          comando:          null,
          numero_conectado: info?.wid?.user   ?? null,
          device_name:      info?.pushname    ?? null,
          ultima_conexao:   new Date().toISOString(),
        },
        { onConflict: 'conta_id' },
      )
    })

    client.on('disconnected', async (reason: string) => {
      const eraConectado = this.foiConectado.get(contaId) ?? false
      logger.warn({ contaId, reason, eraConectado }, 'Desconectado')

      this.clients.delete(contaId)
      this.foiConectado.delete(contaId)
      this.prontoEm.delete(contaId)

      await this.supabase.from('conexoes').upsert(
        { conta_id: contaId, status: 'desconectado', qr_code: null, comando: null },
        { onConflict: 'conta_id' },
      )

      if (reason !== 'LOGOUT' && eraConectado) {
        const tentativas = (this.tentativas.get(contaId) ?? 0) + 1
        this.tentativas.set(contaId, tentativas)
        if (tentativas <= 5) {
          const delay = Math.min(5_000 * tentativas, 60_000)
          logger.info({ contaId, tentativa: tentativas, delay }, 'Reconectando...')
          setTimeout(() => this.conectar(contaId), delay)
        } else {
          logger.error({ contaId }, 'Número máximo de tentativas — aguardando comando manual.')
          this.tentativas.delete(contaId)
        }
      }
    })

    await client.initialize()
  }

  // ── Desconectar (logout real no WhatsApp) ──────────────────────────────────
  async desconectar(contaId: string) {
    const client = this.clients.get(contaId)
    if (client) {
      try { await client.logout() }  catch {}
      try { await client.destroy() } catch {}
    }

    this.clients.delete(contaId)
    this.foiConectado.delete(contaId)
    this.prontoEm.delete(contaId)
    this.tentativas.delete(contaId)

    // Apagar sessão do disco (LocalAuth salva em session-{contaId}/)
    await fs.rm(path.join(SESSIONS_DIR, `session-${contaId}`), { recursive: true, force: true })

    await this.supabase.from('conexoes').upsert(
      {
        conta_id:         contaId,
        status:           'desconectado',
        qr_code:          null,
        comando:          null,
        numero_conectado: null,
        device_name:      null,
      },
      { onConflict: 'conta_id' },
    )
  }

  // ── Reconectar (novo QR) ────────────────────────────────────────────────────
  async reconectar(contaId: string) {
    await this.encerrarCliente(contaId)
    await this.conectar(contaId)
  }

  // ── Enviar mensagem com simulação de digitação ──────────────────────────────
  async enviarMensagem(contaId: string, para: string, texto: string, semDigitacao = false): Promise<void> {
    const client = this.clients.get(contaId)
    if (!client) throw new Error(`[${contaId}] Sem cliente ativo.`)

    const chatId = para.includes('@') ? para : `${para}@c.us`

    if (!semDigitacao) {
      const digitandoMs = 23_000 + Math.floor(Math.random() * 4_000)
      try {
        const chat = await client.getChatById(chatId)
        await chat.sendStateTyping()
        await sleep(digitandoMs)
        await chat.clearState()
      } catch {
        // falha no state não impede o envio
      }
    }

    await client.sendMessage(chatId, texto)
  }

  /**
   * Retorna true se o client existe e está pronto.
   * bypassWarmup=true: ignora warmup (para mensagens imediatas como pagamento_confirmado).
   */
  hasSocket(contaId: string, bypassWarmup = false): boolean {
    if (!this.clients.has(contaId)) return false
    if (bypassWarmup) return true
    const pronto = this.prontoEm.get(contaId) ?? 0
    return Date.now() >= pronto
  }

  /** Quantas contas têm client ativo. */
  contasConectadas(): number {
    return this.clients.size
  }

  private async encerrarCliente(contaId: string) {
    const client = this.clients.get(contaId)
    if (client) {
      try { await client.destroy() } catch {}
      this.clients.delete(contaId)
    }
    this.prontoEm.delete(contaId)
    this.tentativas.delete(contaId)
    this.foiConectado.delete(contaId)
  }
}
