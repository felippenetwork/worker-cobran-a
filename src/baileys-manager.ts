// Gerenciador de sockets Baileys — 1 socket por conta (tenant).
// Regras anti-ban (§3 skill baileys-conexao):
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function sessionPath(contaId: string): string {
  return path.join(SESSIONS_DIR, contaId)
}

/** Extrai número limpo do JID do Baileys (5511999999999:0@s.whatsapp.net → 5511999999999) */
function extrairNumero(jid: string | undefined): string | null {
  return jid?.split(':')[0] ?? null
}

// ── Anti-ban: intervalo e janela de envio ────────────────────────────────────

export function intervalAleatório(min = 45_000, max = 80_000): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

export function dentroDaJanela(): boolean {
  const agora = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }),
  )
  const hora = agora.getHours()
  return hora >= 9 && hora < 20
}

// ── Gerenciador principal ─────────────────────────────────────────────────────

// Quanto tempo aguardar após conectar antes de liberar envios.
// Evita disparar mensagens enquanto a sessão ainda está sincronizando.
const WARMUP_MS = 60_000  // 1 minuto

export class BaileysManager {
  private sockets    = new Map<string, WASocket>()
  private tentativas = new Map<string, number>()
  private prontoEm   = new Map<string, number>()  // contaId → timestamp de quando fica pronto

  constructor(private supabase: SupabaseAdmin) {}

  // ── Restaurar sessões na inicialização do worker ────────────────────────────
  async restaurarSessoes() {
    const { data } = await this.supabase
      .from('conexoes')
      .select('conta_id, status')
      .not('status', 'eq', 'desconectado')

    for (const row of data ?? []) {
      const contaId = row.conta_id as string
      try {
        await this.conectar(contaId)
      } catch (err) {
        logger.error({ contaId, err }, 'Erro ao restaurar sessão')
      }
    }
  }

  // ── Conectar (ou reconectar) uma conta ─────────────────────────────────────
  async conectar(contaId: string) {
    // Evita abrir dois sockets para a mesma conta
    if (this.sockets.has(contaId)) {
      await this.encerrarSocket(contaId)
    }

    await fs.mkdir(sessionPath(contaId), { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath(contaId))
    const { version }          = await fetchLatestBaileysVersion()

    // Keep-alive com jitter (padrão do DPGP-API — reduz risco de timeout)
    const keepAliveMs = 55_000 + Math.floor(Math.random() * 35_000)

    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, logger.child({ contaId }) as any),
      },
      browser:                        Browsers.macOS('Safari'), // fingerprint anti-ban
      printQRInTerminal:              false,
      logger:                         logger.child({ contaId }) as Parameters<typeof makeWASocket>[0]['logger'],

      // ── Reduz chamadas à Meta ao conectar ─────────────────────────────────
      markOnlineOnConnect:            false,   // não muda status para "online"
      syncFullHistory:                false,   // não baixa histórico de mensagens
      generateHighQualityLinkPreview: false,   // não faz requisição externa para preview
      fireInitQueries:                false,   // não executa queries de inicialização extras
      getMessage:                     async () => undefined, // não busca msgs antigas ao reconectar

      // ── Keep-alive com jitter — evita padrão previsível ───────────────────
      keepAliveIntervalMs:            keepAliveMs,
      connectTimeoutMs:               60_000,
      retryRequestDelayMs:            500,
    })

    this.sockets.set(contaId, socket)

    // Persiste credenciais sempre que atualizadas
    socket.ev.on('creds.update', saveCreds)

    // Eventos de conexão
    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      // Novo QR recebido — worker grava; frontend lê via Realtime
      if (qr) {
        logger.info({ contaId }, 'QR gerado')
        await this.supabase
          .from('conexoes')
          .upsert(
            { conta_id: contaId, status: 'conectando', qr_code: qr, comando: null },
            { onConflict: 'conta_id' },
          )
      }

      if (connection === 'open') {
        const numero = extrairNumero(socket.user?.id)
        logger.info({ contaId, numero }, 'Conectado')
        this.tentativas.delete(contaId)

        // Warmup: bloquear envios por WARMUP_MS para a sessão estabilizar
        // sem fazer chamadas desnecessárias à Meta logo após conectar.
        this.prontoEm.set(contaId, Date.now() + WARMUP_MS)
        logger.info({ contaId, warmupSeg: WARMUP_MS / 1000 }, 'Warmup iniciado — envios bloqueados temporariamente')

        await this.supabase
          .from('conexoes')
          .upsert(
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
        const loggedOut = code === DisconnectReason.loggedOut

        logger.warn({ contaId, code }, `Conexão encerrada${loggedOut ? ' (logout)' : ''}`)
        this.sockets.delete(contaId)

        await this.supabase
          .from('conexoes')
          .upsert(
            { conta_id: contaId, status: 'desconectado', qr_code: null, comando: null },
            { onConflict: 'conta_id' },
          )

        if (!loggedOut) {
          // Reconexão automática com backoff (máx 5 tentativas)
          const tentativas = (this.tentativas.get(contaId) ?? 0) + 1
          this.tentativas.set(contaId, tentativas)

          if (tentativas <= 5) {
            const delay = Math.min(5_000 * tentativas, 60_000)
            logger.info({ contaId, tentativa: tentativas, delay }, 'Reconectando...')
            setTimeout(() => this.conectar(contaId), delay)
          } else {
            logger.error({ contaId }, 'Número máximo de tentativas atingido — aguardando comando manual.')
            this.tentativas.delete(contaId)
          }
        }
      }
    })

    // Ack de mensagens → atualiza log de notificações (Sprint 8)
    socket.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (update.update.status) {
          // Sprint 8: mapear ack do Baileys para notificacoes_enviadas
          logger.debug({ contaId, msgId: update.key.id, ack: update.update.status }, 'Ack recebido')
        }
      }
    })
  }

  // ── Desconectar (logout) ────────────────────────────────────────────────────
  async desconectar(contaId: string) {
    await this.encerrarSocket(contaId)

    // Apagar sessão do disco (evita restauração indesejada)
    await fs.rm(sessionPath(contaId), { recursive: true, force: true })

    await this.supabase
      .from('conexoes')
      .upsert(
        { conta_id: contaId, status: 'desconectado', qr_code: null, comando: null },
        { onConflict: 'conta_id' },
      )
  }

  // ── Reconectar (reiniciar com novo QR) ─────────────────────────────────────
  async reconectar(contaId: string) {
    await this.encerrarSocket(contaId)
    await this.conectar(contaId)
  }

  // ── Enviar mensagem com simulação de digitação ───────────────────────────────
  // Fluxo anti-ban:
  //   1. sendPresenceUpdate('composing') → WhatsApp exibe "digitando..."
  //   2. aguarda ~25s (com leve jitter para não ser previsível)
  //   3. sendPresenceUpdate('paused')   → para de "digitar"
  //   4. sendMessage                    → envia a mensagem
  async enviarMensagem(contaId: string, para: string, texto: string): Promise<void> {
    const socket = this.sockets.get(contaId)
    if (!socket) throw new Error(`[${contaId}] Sem socket ativo.`)

    const jid = para.includes('@') ? para : `${para}@s.whatsapp.net`

    // Jitter leve: 23–27s para não parecer robótico
    const digitandoMs = 23_000 + Math.floor(Math.random() * 4_000)

    try {
      await socket.sendPresenceUpdate('composing', jid)
      await sleep(digitandoMs)
      await socket.sendPresenceUpdate('paused', jid)
    } catch {
      // Falha na presence não impede o envio
    }

    await socket.sendMessage(jid, { text: texto })
  }

  /**
   * Retorna true SOMENTE se o socket existe E já passou o período de warmup.
   * O worker de WhatsApp consulta este método antes de cada envio.
   */
  hasSocket(contaId: string): boolean {
    if (!this.sockets.has(contaId)) return false
    const pronto = this.prontoEm.get(contaId) ?? 0
    return Date.now() >= pronto
  }

  /** Retorna quantas contas têm socket ativo (independente de warmup). */
  contasConectadas(): number {
    return this.sockets.size
  }

  /** Apenas verifica existência do socket, sem checar warmup (uso interno). */
  private socketAtivo(contaId: string): boolean {
    return this.sockets.has(contaId)
  }

  private async encerrarSocket(contaId: string) {
    const socket = this.sockets.get(contaId)
    if (socket) {
      socket.end(new Error('encerrado pelo manager'))
      this.sockets.delete(contaId)
    }
    this.prontoEm.delete(contaId)
    this.tentativas.delete(contaId)
  }
}
