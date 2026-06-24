// Gerenciador de sockets Baileys — 1 socket por conta (tenant).
// Regras anti-ban:
//   • Intervalo: 45–80s aleatório.
//   • Janela: 09:00–20:00 (America/Sao_Paulo).
//   • Fila um-a-um por conta.
//   • Overflow → dia seguinte às 09h.
// ⚠️ Nunca rodar em serverless/Vercel — exclusivo para VPS.

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  type WASocket,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import path from 'path'
import fs from 'fs/promises'
import { sleep } from './format.js'
import type { SupabaseAdmin } from './supabase.js'

const SESSIONS_DIR = process.env.SESSIONS_DIR ?? '/opt/quita/sessions'
const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' })

function sessionPath(contaId: string): string {
  return path.join(SESSIONS_DIR, contaId)
}

function extrairNumero(jid: string | undefined): string | null {
  return jid?.split(':')[0] ?? null
}

const WARMUP_MS = 60_000

export class BaileysManager {
  private sockets       = new Map<string, WASocket>()
  private tentativas    = new Map<string, number>()
  private prontoEm      = new Map<string, number>()
  private foiConectado  = new Map<string, boolean>()

  constructor(private supabase: SupabaseAdmin) {}

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

  async conectar(contaId: string) {
    if (this.sockets.has(contaId)) {
      await this.encerrarSocket(contaId)
    }

    await fs.mkdir(sessionPath(contaId), { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath(contaId))

    let version: [number, number, number] = [2, 3000, 1015901307]
    try { const v = await fetchLatestBaileysVersion(); version = v.version } catch {
      logger.warn({ contaId }, 'fetchLatestBaileysVersion falhou — usando versão fallback')
    }

    const keepAliveMs = 55_000 + Math.floor(Math.random() * 35_000)

    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, logger.child({ contaId }) as any),
      },
      browser:                        Browsers.macOS('Safari'),
      printQRInTerminal:              false,
      logger:                         logger.child({ contaId }) as Parameters<typeof makeWASocket>[0]['logger'],
      markOnlineOnConnect:            false,
      syncFullHistory:                false,
      generateHighQualityLinkPreview: false,
      fireInitQueries:                false,
      getMessage:                     async () => undefined,
      keepAliveIntervalMs:            keepAliveMs,
      connectTimeoutMs:               60_000,
      retryRequestDelayMs:            500,
    })

    this.sockets.set(contaId, socket)
    socket.ev.on('creds.update', saveCreds)

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        logger.info({ contaId }, 'QR gerado')
        await this.supabase.from('conexoes').upsert(
          { conta_id: contaId, status: 'conectando', qr_code: qr, comando: null },
          { onConflict: 'conta_id' },
        )
      }

      if (connection === 'open') {
        const numero = extrairNumero(socket.user?.id)
        logger.info({ contaId, numero }, 'Conectado')
        this.foiConectado.set(contaId, true)
        this.tentativas.delete(contaId)
        this.prontoEm.set(contaId, Date.now() + WARMUP_MS)

        await this.supabase.from('conexoes').upsert(
          {
            conta_id:         contaId,
            status:           'conectado',
            qr_code:          null,
            comando:          null,
            numero_conectado: numero,
            device_name:      socket.user?.name ?? null,
            ultima_conexao:   new Date().toISOString(),
          },
          { onConflict: 'conta_id' },
        )
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as any)?.output?.statusCode
        const loggedOut      = code === DisconnectReason.loggedOut
        const restartRequired = code === DisconnectReason.restartRequired // 515 — após pareamento
        const eraConectado   = this.foiConectado.get(contaId) ?? false

        logger.warn({ contaId, code, eraConectado, restartRequired }, `Conexão encerrada${loggedOut ? ' (logout)' : ''}`)
        this.sockets.delete(contaId)
        this.foiConectado.delete(contaId)

        await this.supabase.from('conexoes').upsert(
          { conta_id: contaId, status: 'desconectado', qr_code: null, comando: null },
          { onConflict: 'conta_id' },
        )

        if (loggedOut) {
          // Sessão inválida — limpa e reconecta imediatamente para gerar novo QR
          await fs.rm(sessionPath(contaId), { recursive: true, force: true })
          logger.info({ contaId }, 'Sessão inválida removida — reconectando para novo QR')
          setTimeout(() => this.conectar(contaId), 2_000)
        }

        if (!loggedOut && (eraConectado || restartRequired)) {
          const tentativas = (this.tentativas.get(contaId) ?? 0) + 1
          this.tentativas.set(contaId, tentativas)
          if (tentativas <= 5) {
            // restartRequired: reconecta rápido (2s) pois as credenciais já estão salvas
            const delay = restartRequired ? 2_000 : Math.min(5_000 * tentativas, 60_000)
            logger.info({ contaId, tentativa: tentativas, delay }, 'Reconectando...')
            setTimeout(() => this.conectar(contaId), delay)
          } else {
            logger.error({ contaId }, 'Número máximo de tentativas atingido.')
            this.tentativas.delete(contaId)
          }
        }
      }
    })
  }

  async desconectar(contaId: string) {
    const socket = this.sockets.get(contaId)
    if (socket) {
      // logout() invalida a sessão no WhatsApp — força novo QR na próxima conexão
      try { await socket.logout() } catch {}
    }
    await this.encerrarSocket(contaId)
    await fs.rm(sessionPath(contaId), { recursive: true, force: true })

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

  async reconectar(contaId: string) {
    await this.encerrarSocket(contaId)
    await this.conectar(contaId)
  }

  async enviarMensagem(contaId: string, para: string, texto: string, semDigitacao = false): Promise<void> {
    const socket = this.sockets.get(contaId)
    if (!socket) throw new Error(`[${contaId}] Sem socket ativo.`)

    const jid = para.includes('@') ? para : `${para}@s.whatsapp.net`

    if (!semDigitacao) {
      const digitandoMs = 23_000 + Math.floor(Math.random() * 4_000)
      try {
        await socket.sendPresenceUpdate('composing', jid)
        await sleep(digitandoMs)
        await socket.sendPresenceUpdate('paused', jid)
      } catch {}
    }

    await socket.sendMessage(jid, { text: texto })
  }

  hasSocket(contaId: string, bypassWarmup = false): boolean {
    if (!this.sockets.has(contaId)) return false
    if (bypassWarmup) return true
    const pronto = this.prontoEm.get(contaId) ?? 0
    return Date.now() >= pronto
  }

  contasConectadas(): number {
    return this.sockets.size
  }

  private async encerrarSocket(contaId: string) {
    const socket = this.sockets.get(contaId)
    if (socket) {
      socket.end(new Error('encerrado pelo manager'))
      this.sockets.delete(contaId)
    }
    this.prontoEm.delete(contaId)
    this.tentativas.delete(contaId)
    this.foiConectado.delete(contaId)
  }
}
