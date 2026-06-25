// UazapiManager — substitui BaileysManager usando uazapi REST API.
// Mesma interface pública do BaileysManager: o resto do worker não muda.
// Env: UAZAPI_URL, UAZAPI_GLOBAL_TOKEN

import pino from 'pino'
import { sleep } from './format.js'
import type { SupabaseAdmin } from './supabase.js'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' })

const BASE_URL    = (process.env.UAZAPI_URL          ?? '').replace(/\/$/, '')
const GLOBAL_TOKEN = process.env.UAZAPI_GLOBAL_TOKEN ?? ''

// Nome da instância no uazapi (máx ~30 chars, sem traços)
function instName(contaId: string): string {
  return `quita${contaId.replace(/-/g, '').slice(0, 10)}`
}

async function api(method: string, path: string, body?: object): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: GLOBAL_TOKEN },
    body:    body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`uazapi ${method} ${path} → ${res.status}: ${text}`)
  try { return JSON.parse(text) } catch { return text }
}

export class UazapiManager {
  private connected = new Set<string>()  // contaIds com estado 'open'
  private polling   = new Set<string>()  // contaIds com loop de polling ativo

  constructor(private supabase: SupabaseAdmin) {}

  // ── Startup: verifica quais instâncias ainda estão conectadas no uazapi ──────
  async restaurarSessoes() {
    const { data } = await this.supabase
      .from('conexoes').select('conta_id').eq('status', 'conectado')

    for (const row of data ?? []) {
      const contaId = row.conta_id as string
      try {
        const state = await this.pegarEstado(contaId)
        if (state === 'open') {
          this.connected.add(contaId)
          this.iniciarPolling(contaId)
          logger.info({ contaId }, 'uazapi: sessão restaurada')
        } else {
          await this.marcarDesconectado(contaId)
        }
      } catch {
        await this.marcarDesconectado(contaId)
      }
    }
  }

  // ── Criar instância + gerar QR ────────────────────────────────────────────────
  async conectar(contaId: string) {
    const name = instName(contaId)

    // Cria instância (ignora erro se já existir)
    try {
      await api('POST', '/instance/create', {
        instanceName: name,
        qrcode:       true,
        integration:  'WHATSAPP-BAILEYS',
      })
      logger.info({ contaId, name }, 'uazapi: instância criada')
    } catch (err) {
      logger.warn({ contaId, err }, 'uazapi: create (pode já existir — ok)')
    }

    await this.supabase.from('conexoes').upsert(
      { conta_id: contaId, status: 'conectando', qr_code: null, comando: null },
      { onConflict: 'conta_id' },
    )

    await sleep(2_000)
    await this.buscarEGravarQR(contaId)
    this.iniciarPolling(contaId)
  }

  // ── Logout + limpar ───────────────────────────────────────────────────────────
  async desconectar(contaId: string) {
    const name = instName(contaId)
    try { await api('DELETE', `/instance/logout/${name}`) } catch (err) {
      logger.warn({ contaId, err }, 'uazapi: logout (pode já estar desconectado)')
    }
    this.connected.delete(contaId)
    this.polling.delete(contaId)
    await this.supabase.from('conexoes').upsert(
      { conta_id: contaId, status: 'desconectado', qr_code: null, comando: null,
        numero_conectado: null, device_name: null },
      { onConflict: 'conta_id' },
    )
  }

  // ── Reiniciar conexão (gera novo QR) ─────────────────────────────────────────
  async reconectar(contaId: string) {
    this.connected.delete(contaId)
    this.polling.delete(contaId)
    try { await api('DELETE', `/instance/logout/${instName(contaId)}`) } catch {}
    await sleep(2_000)
    await this.conectar(contaId)
  }

  // ── Enviar mensagem ───────────────────────────────────────────────────────────
  async enviarMensagem(
    contaId: string,
    para: string,
    texto: string,
    semDigitacao = false,
  ): Promise<void> {
    const name = instName(contaId)

    if (!semDigitacao) {
      const ms = 7_000 + Math.floor(Math.random() * 2_000) // 7–9s
      try {
        await api('POST', `/chat/updatePresence/${name}`, {
          number: para, presence: 'composing',
        })
        await sleep(ms)
        await api('POST', `/chat/updatePresence/${name}`, {
          number: para, presence: 'paused',
        })
      } catch {}
    }

    await api('POST', `/message/sendText/${name}`, { number: para, text: texto })
  }

  // ── Interface compartilhada com BaileysManager ────────────────────────────────
  hasSocket(contaId: string, _bypassWarmup = false): boolean {
    return this.connected.has(contaId)
  }

  contasConectadas(): number {
    return this.connected.size
  }

  // ── Privados ──────────────────────────────────────────────────────────────────

  private async pegarEstado(contaId: string): Promise<string> {
    const data = await api('GET', `/instance/connectionState/${instName(contaId)}`)
    // Evolution API: { instance: { state: 'open'|'close'|'connecting' } }
    return (data?.instance?.state ?? data?.state ?? 'close') as string
  }

  private async buscarEGravarQR(contaId: string) {
    try {
      const data = await api('GET', `/instance/connect/${instName(contaId)}`)
      // QR pode estar em campos diferentes dependendo da versão
      const qr = data?.base64 ?? data?.qrcode?.base64 ?? data?.qr ?? null
      if (qr) {
        await this.supabase.from('conexoes').upsert(
          { conta_id: contaId, qr_code: qr, status: 'conectando' },
          { onConflict: 'conta_id' },
        )
        logger.info({ contaId }, 'uazapi: QR gravado no banco')
      }
    } catch (err) {
      logger.warn({ contaId, err }, 'uazapi: erro ao buscar QR')
    }
  }

  private async marcarDesconectado(contaId: string) {
    await this.supabase.from('conexoes').upsert(
      { conta_id: contaId, status: 'desconectado', qr_code: null, comando: null },
      { onConflict: 'conta_id' },
    )
  }

  // Polling de estado: atualiza connected set e banco a cada 10s
  private iniciarPolling(contaId: string) {
    if (this.polling.has(contaId)) return
    this.polling.add(contaId)

    const loop = async () => {
      while (this.polling.has(contaId)) {
        await sleep(10_000)
        try {
          const state = await this.pegarEstado(contaId)

          if (state === 'open' && !this.connected.has(contaId)) {
            this.connected.add(contaId)
            logger.info({ contaId }, 'uazapi: conectado!')
            // Tenta capturar número conectado
            try {
              const instances = await api('GET', '/instance/fetchInstances')
              const inst = (instances ?? []).find(
                (i: any) => i.instance?.instanceName === instName(contaId),
              )
              const numero = inst?.instance?.owner?.split('@')[0] ?? null
              await this.supabase.from('conexoes').upsert(
                { conta_id: contaId, status: 'conectado', qr_code: null, comando: null,
                  numero_conectado: numero, ultima_conexao: new Date().toISOString() },
                { onConflict: 'conta_id' },
              )
            } catch {}
          }

          if (state !== 'open' && this.connected.has(contaId)) {
            this.connected.delete(contaId)
            logger.warn({ contaId }, 'uazapi: perdeu conexão')
            await this.marcarDesconectado(contaId)
          }

          // Se ainda conectando, tenta buscar QR novamente
          if (state === 'close' && !this.connected.has(contaId)) {
            await this.buscarEGravarQR(contaId)
          }
        } catch (err) {
          logger.error({ contaId, err }, 'uazapi: erro no polling')
        }
      }
    }

    loop()
  }
}
