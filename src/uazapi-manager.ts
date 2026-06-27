// UazapiManager — uazapi v2 REST API (supercloudstore.uazapi.com).
// Mesma interface pública do BaileysManager: o resto do worker não muda.
// Env: UAZAPI_URL, UAZAPI_GLOBAL_TOKEN

import pino from 'pino'
import { sleep } from './format.js'
import type { SupabaseAdmin } from './supabase.js'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' })

const BASE_URL     = (process.env.UAZAPI_URL          ?? '').replace(/\/$/, '')
const GLOBAL_TOKEN = process.env.UAZAPI_GLOBAL_TOKEN ?? ''

function instName(contaId: string): string {
  return `quita${contaId.replace(/-/g, '').slice(0, 10)}`
}

// Operações admin — requerem header admintoken
async function adminApi(method: string, path: string, body?: object): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'admintoken': GLOBAL_TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`uazapi admin ${method} ${path} → ${res.status}: ${text}`)
  try { return JSON.parse(text) } catch { return text }
}

// Operações de instância — requerem header token (token por instância)
async function instanceApi(instanceToken: string, method: string, path: string, body?: object): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'token': instanceToken },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`uazapi inst ${method} ${path} → ${res.status}: ${text}`)
  try { return JSON.parse(text) } catch { return text }
}

export class UazapiManager {
  private connected      = new Set<string>()           // contaIds com estado 'connected'
  private polling        = new Set<string>()           // contaIds com loop de polling ativo
  private instanceTokens = new Map<string, string>()   // contaId → instance token

  constructor(private supabase: SupabaseAdmin) {}

  // ── Startup: verifica quais instâncias ainda estão conectadas no uazapi ──────
  async restaurarSessoes() {
    // Busca TODAS as contas com linha em conexoes — não filtra por status no banco
    // porque o banco pode mostrar 'desconectado' mesmo que o uazapi ainda esteja ativo
    // (ex: worker reiniciou após circuit-breaker). A fonte de verdade é o uazapi.
    const { data: conexoes } = await this.supabase
      .from('conexoes').select('conta_id')

    if (!conexoes?.length) return

    let allInstances: any[] = []
    try {
      allInstances = await adminApi('GET', '/instance/all')
    } catch (err) {
      logger.error({ err }, 'uazapi: falha ao listar instâncias no startup')
      return
    }

    for (const row of conexoes) {
      const contaId = row.conta_id as string
      const name    = instName(contaId)
      const inst    = allInstances.find((i: any) => i.name === name)

      if (!inst) {
        await this.marcarDesconectado(contaId)
        continue
      }

      this.instanceTokens.set(contaId, inst.token as string)

      if (inst.status === 'connected') {
        this.connected.add(contaId)
        // Sincronizar DB — pode estar em 'conectando' se o worker reiniciou durante conexão
        try {
          const data   = await instanceApi(inst.token as string, 'GET', '/instance/status')
          const numero = (data?.status?.jid?.user as string) ?? null
          const nome   = (data?.instance?.profileName as string) ?? null
          await this.supabase.from('conexoes').upsert(
            { conta_id: contaId, status: 'conectado', qr_code: null, comando: null,
              numero_conectado: numero, device_name: nome,
              ultima_conexao: new Date().toISOString() },
            { onConflict: 'conta_id' },
          )
        } catch {}
        this.iniciarPolling(contaId)
        logger.info({ contaId }, 'uazapi: sessão restaurada')
      } else {
        await this.marcarDesconectado(contaId)
      }
    }
  }

  // ── Criar instância + iniciar conexão + aguardar QR ──────────────────────────
  async conectar(contaId: string) {
    const name = instName(contaId)
    let token  = this.instanceTokens.get(contaId)

    if (!token) {
      try {
        const data = await adminApi('POST', '/instance/create', { name })
        token = data.token as string
        this.instanceTokens.set(contaId, token)
        logger.info({ contaId, name }, 'uazapi: instância criada')
      } catch (err: any) {
        // Instância pode já existir — tentar recuperar token via /instance/all
        try {
          const all  = await adminApi('GET', '/instance/all')
          const inst = all.find((i: any) => i.name === name)
          if (inst?.token) {
            token = inst.token as string
            this.instanceTokens.set(contaId, token)
            logger.info({ contaId }, 'uazapi: instância já existia — token recuperado')
          } else {
            throw err
          }
        } catch {
          logger.error({ contaId, err }, 'uazapi: falha ao criar instância')
          throw err
        }
      }
    }

    await this.supabase.from('conexoes').upsert(
      { conta_id: contaId, status: 'conectando', qr_code: null, comando: null },
      { onConflict: 'conta_id' },
    )

    // Inicia processo de conexão → gera QR code
    try {
      await instanceApi(token, 'POST', '/instance/connect')
    } catch (err) {
      logger.warn({ contaId, err }, 'uazapi: /instance/connect (pode já estar conectando)')
    }

    await sleep(2_000)
    await this.buscarEGravarQR(contaId)
    this.iniciarPolling(contaId)
  }

  // ── Logout ────────────────────────────────────────────────────────────────────
  async desconectar(contaId: string) {
    const token = this.instanceTokens.get(contaId)
    if (token) {
      try {
        await instanceApi(token, 'POST', '/instance/disconnect')
      } catch (err) {
        logger.warn({ contaId, err }, 'uazapi: disconnect (pode já estar desconectado)')
      }
    }
    this.connected.delete(contaId)
    this.polling.delete(contaId)
    await this.supabase.from('conexoes').upsert(
      { conta_id: contaId, status: 'desconectado', qr_code: null, comando: null,
        numero_conectado: null, device_name: null },
      { onConflict: 'conta_id' },
    )
  }

  // ── Reiniciar: sincroniza estado sem desconectar ──────────────────────────────
  async reconectar(contaId: string) {
    // Se token não está em memória (ex: worker reiniciou com conta em status desconectado
    // no banco mas instância ainda ativa no uazapi), recuperar via /instance/all antes
    // de checar o estado — caso contrário pegarEstado() retorna 'disconnected' sem verificar.
    if (!this.instanceTokens.has(contaId)) {
      try {
        const all  = await adminApi('GET', '/instance/all')
        const inst = (all as any[]).find((i: any) => i.name === instName(contaId))
        if (inst?.token) {
          this.instanceTokens.set(contaId, inst.token as string)
          logger.info({ contaId }, 'uazapi: token recuperado via /instance/all no reconectar')
        }
      } catch (err) {
        logger.warn({ contaId, err }, 'uazapi: falha ao recuperar token — tentando conectar()')
      }
    }

    // Checar estado real no uazapi antes de qualquer ação destrutiva
    let estadoAtual: 'connected' | 'disconnected' | 'connecting' = 'disconnected'
    try { estadoAtual = await this.pegarEstado(contaId) } catch {}

    if (estadoAtual === 'connected') {
      // Já conectado — apenas sincronizar banco, sem desconectar
      const token = this.instanceTokens.get(contaId)
      if (token) {
        try {
          const data   = await instanceApi(token, 'GET', '/instance/status')
          const numero = (data?.status?.jid?.user as string) ?? null
          const nome   = (data?.instance?.profileName as string) ?? null
          await this.supabase.from('conexoes').upsert(
            { conta_id: contaId, status: 'conectado', qr_code: null, comando: null,
              numero_conectado: numero, device_name: nome,
              ultima_conexao: new Date().toISOString() },
            { onConflict: 'conta_id' },
          )
        } catch {}
      }
      this.connected.add(contaId)
      this.iniciarPolling(contaId)
      logger.info({ contaId }, 'uazapi: reiniciar — já conectado, banco sincronizado')
      return
    }

    // Não conectado — iniciar nova conexão sem desconectar (preserva sessão se existir)
    this.connected.delete(contaId)
    this.polling.delete(contaId)
    await this.conectar(contaId)
  }

  // ── Enviar mensagem ───────────────────────────────────────────────────────────
  async enviarMensagem(
    contaId: string,
    para: string,
    texto: string,
    semDigitacao = false,
  ): Promise<void> {
    const token = this.instanceTokens.get(contaId)
    if (!token) throw new Error(`uazapi: sem token para conta ${contaId}`)

    if (!semDigitacao) {
      const ms = 7_000 + Math.floor(Math.random() * 2_000)  // 7–9s
      try {
        // Presença async — cancelada automaticamente quando a mensagem é enviada
        await instanceApi(token, 'POST', '/message/presence', {
          number: para, presence: 'composing', delay: ms,
        })
        await sleep(ms)
      } catch (err) {
        logger.warn({ contaId, err }, 'uazapi: falha no presence (não crítico)')
      }
    }

    await instanceApi(token, 'POST', '/send/text', { number: para, text: texto })
  }

  // ── Interface compartilhada ───────────────────────────────────────────────────
  hasSocket(contaId: string, _bypassWarmup = false): boolean {
    return this.connected.has(contaId)
  }

  contasConectadas(): number {
    return this.connected.size
  }

  // ── Privados ──────────────────────────────────────────────────────────────────

  private async pegarEstado(contaId: string): Promise<'connected' | 'disconnected' | 'connecting'> {
    const token = this.instanceTokens.get(contaId)
    if (!token) return 'disconnected'
    try {
      const data = await instanceApi(token, 'GET', '/instance/status')
      if (data?.status?.connected === true) return 'connected'
      const s = (data?.instance?.status as string) ?? 'disconnected'
      if (s === 'connected')  return 'connected'
      if (s === 'connecting') return 'connecting'
      return 'disconnected'
    } catch (err: any) {
      // 404 = instância deletada no uazapi → limpar token stale e retornar desconectado
      // (não lançar — o loop de polling detecta 'disconnected' e chama marcarDesconectado())
      if (/404/.test(String(err?.message ?? ''))) {
        this.instanceTokens.delete(contaId)
        return 'disconnected'
      }
      throw err
    }
  }

  private async buscarEGravarQR(contaId: string) {
    const token = this.instanceTokens.get(contaId)
    if (!token) return
    try {
      const data = await instanceApi(token, 'GET', '/instance/status')
      const qr   = data?.instance?.qrcode ?? null
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

  // Varredura periódica: sincroniza estado real do uazapi com o banco.
  // Chamada a cada 5 min pelo index.ts. Só age sobre contas SEM polling ativo —
  // contas com polling gerenciam o próprio estado pelo loop de 10s.
  async sincronizarConexoes() {
    const { data: conexoes } = await this.supabase
      .from('conexoes').select('conta_id')

    if (!conexoes?.length) return

    let allInstances: any[] = []
    try {
      allInstances = await adminApi('GET', '/instance/all')
    } catch (err) {
      logger.error({ err }, 'uazapi: sincronizarConexoes — falha ao listar instâncias')
      return
    }

    for (const row of conexoes) {
      const contaId = row.conta_id as string

      // Conta com polling ativo: o loop de 10s já cuida do estado — não interferir
      if (this.polling.has(contaId)) continue

      const name = instName(contaId)
      const inst = allInstances.find((i: any) => i.name === name)

      if (!inst) {
        // Instância não existe no uazapi — garantir DB consistente
        if (this.connected.has(contaId)) {
          this.connected.delete(contaId)
          await this.marcarDesconectado(contaId)
        }
        continue
      }

      // Sempre atualizar token em memória (pode ter mudado após restart do uazapi)
      this.instanceTokens.set(contaId, inst.token as string)

      if (inst.status === 'connected') {
        // Conectado no uazapi mas polling não está rodando → restaurar
        this.connected.add(contaId)
        try {
          const data   = await instanceApi(inst.token as string, 'GET', '/instance/status')
          const numero = (data?.status?.jid?.user as string) ?? null
          const nome   = (data?.instance?.profileName as string) ?? null
          await this.supabase.from('conexoes').upsert(
            { conta_id: contaId, status: 'conectado', qr_code: null, comando: null,
              numero_conectado: numero, device_name: nome,
              ultima_conexao: new Date().toISOString() },
            { onConflict: 'conta_id' },
          )
        } catch {}
        this.iniciarPolling(contaId)
        logger.info({ contaId }, 'uazapi: sincronizarConexoes — sessão restaurada, polling reiniciado')

      } else if (inst.status === 'connecting') {
        // Gerou QR mas ninguém escaneou — atualizar QR no banco e sinalizar ao usuário
        await this.buscarEGravarQR(contaId)
        try {
          await this.supabase.from('conexoes').upsert(
            { conta_id: contaId, status: 'conectando', comando: null },
            { onConflict: 'conta_id' },
          )
        } catch {}
        this.iniciarPolling(contaId)
        logger.info({ contaId }, 'uazapi: sincronizarConexoes — QR atualizado')

      } else {
        // Desconectado no uazapi e sem polling → garantir DB consistente
        if (this.connected.has(contaId)) this.connected.delete(contaId)
        await this.marcarDesconectado(contaId)
        logger.info({ contaId }, 'uazapi: sincronizarConexoes — marcado desconectado')
      }
    }
  }

  // Tenta restaurar a sessão automaticamente após queda de conexão.
  // Retorna 'conectado' se OK, 'conectando' se gerou QR (precisa de scan),
  // ou 'falhou' se esgotou tentativas.
  private async tentarReconectarAuto(
    contaId: string,
  ): Promise<'conectado' | 'conectando' | 'falhou'> {
    const MAX_TENTATIVAS  = 3
    const DELAY_INICIAL   = 3_000   // deixar uazapi processar a queda antes de reconectar
    const DELAY_CONECTAR  = 8_000   // aguardar sessão estabelecer após /instance/connect
    const DELAY_TENTATIVA = 20_000  // pausa entre tentativas fracassadas

    await sleep(DELAY_INICIAL)

    for (let i = 1; i <= MAX_TENTATIVAS; i++) {
      if (!this.polling.has(contaId)) return 'falhou' // desconectado manualmente durante tentativa

      const token = this.instanceTokens.get(contaId)
      if (!token) return 'falhou'

      logger.info({ contaId, tentativa: i }, 'uazapi: reconexão automática — tentativa')

      try {
        await instanceApi(token, 'POST', '/instance/connect')
      } catch (err) {
        logger.warn({ contaId, tentativa: i, err }, 'uazapi: /instance/connect falhou (não crítico)')
      }

      await sleep(DELAY_CONECTAR)
      if (!this.polling.has(contaId)) return 'falhou'

      let state: 'connected' | 'disconnected' | 'connecting' = 'disconnected'
      try { state = await this.pegarEstado(contaId) } catch {}

      if (state === 'connected') {
        this.connected.add(contaId)
        try {
          const data   = await instanceApi(token, 'GET', '/instance/status')
          const numero = (data?.status?.jid?.user as string) ?? null
          const nome   = (data?.instance?.profileName as string) ?? null
          await this.supabase.from('conexoes').upsert(
            { conta_id: contaId, status: 'conectado', qr_code: null, comando: null,
              numero_conectado: numero, device_name: nome,
              ultima_conexao: new Date().toISOString() },
            { onConflict: 'conta_id' },
          )
        } catch {}
        logger.info({ contaId, tentativa: i }, 'uazapi: reconexão automática bem-sucedida')
        return 'conectado'
      }

      if (state === 'connecting') {
        // Sessão expirou — gerou novo QR, aguardar scan do usuário
        await this.buscarEGravarQR(contaId)
        try {
          await this.supabase.from('conexoes').upsert(
            { conta_id: contaId, status: 'conectando', comando: null },
            { onConflict: 'conta_id' },
          )
        } catch {}
        logger.info({ contaId }, 'uazapi: reconexão automática gerou QR — aguardando scan do usuário')
        return 'conectando'
      }

      if (i < MAX_TENTATIVAS) {
        logger.info({ contaId, tentativa: i }, 'uazapi: ainda desconectado — aguardando próxima tentativa')
        await sleep(DELAY_TENTATIVA)
      }
    }

    logger.warn({ contaId }, 'uazapi: reconexão automática esgotou todas as tentativas')
    return 'falhou'
  }

  // Polling de estado a cada 10s — circuit breaker após 10 erros consecutivos
  private iniciarPolling(contaId: string) {
    if (this.polling.has(contaId)) return
    this.polling.add(contaId)

    const MAX_ERROS = 10
    let erros = 0

    const loop = async () => {
      while (this.polling.has(contaId)) {
        await sleep(10_000)
        try {
          const state = await this.pegarEstado(contaId)
          erros = 0  // reset no sucesso

          if (state === 'connected' && !this.connected.has(contaId)) {
            this.connected.add(contaId)
            logger.info({ contaId }, 'uazapi: conectado!')
            try {
              const tok  = this.instanceTokens.get(contaId)!
              const data = await instanceApi(tok, 'GET', '/instance/status')
              const jid    = data?.status?.jid
              const numero = jid?.user ?? null
              const nome   = data?.instance?.profileName ?? null
              await this.supabase.from('conexoes').upsert(
                { conta_id: contaId, status: 'conectado', qr_code: null, comando: null,
                  numero_conectado: numero, device_name: nome,
                  ultima_conexao: new Date().toISOString() },
                { onConflict: 'conta_id' },
              )
            } catch {}
          }

          if (state !== 'connected' && this.connected.has(contaId)) {
            this.connected.delete(contaId)
            logger.warn({ contaId }, 'uazapi: perdeu conexão — iniciando reconexão automática')
            const resultado = await this.tentarReconectarAuto(contaId)
            if (resultado === 'falhou') await this.marcarDesconectado(contaId)
          }

          if (state === 'connecting') {
            await this.buscarEGravarQR(contaId)
          }

        } catch (err) {
          erros++
          logger.error({ contaId, err, erros }, 'uazapi: erro no polling')

          if (erros >= MAX_ERROS) {
            logger.error({ contaId }, 'uazapi: muitos erros consecutivos — parando polling')
            this.polling.delete(contaId)
            this.connected.delete(contaId)
            try { await this.marcarDesconectado(contaId) } catch {}
            return
          }
        }
      }
    }

    loop()
  }
}
