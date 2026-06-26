// UazapiManager — uazapi v2 REST API (supercloudstore.uazapi.com).
// Mesma interface pública do BaileysManager: o resto do worker não muda.
// Env: UAZAPI_URL, UAZAPI_GLOBAL_TOKEN
import pino from 'pino';
import { sleep } from './format.js';
const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });
const BASE_URL = (process.env.UAZAPI_URL ?? '').replace(/\/$/, '');
const GLOBAL_TOKEN = process.env.UAZAPI_GLOBAL_TOKEN ?? '';
function instName(contaId) {
    return `quita${contaId.replace(/-/g, '').slice(0, 10)}`;
}
// Operações admin — requerem header admintoken
async function adminApi(method, path, body) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'admintoken': GLOBAL_TOKEN },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok)
        throw new Error(`uazapi admin ${method} ${path} → ${res.status}: ${text}`);
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
// Operações de instância — requerem header token (token por instância)
async function instanceApi(instanceToken, method, path, body) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'token': instanceToken },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok)
        throw new Error(`uazapi inst ${method} ${path} → ${res.status}: ${text}`);
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
export class UazapiManager {
    supabase;
    connected = new Set(); // contaIds com estado 'connected'
    polling = new Set(); // contaIds com loop de polling ativo
    instanceTokens = new Map(); // contaId → instance token
    constructor(supabase) {
        this.supabase = supabase;
    }
    // ── Startup: verifica quais instâncias ainda estão conectadas no uazapi ──────
    async restaurarSessoes() {
        // Inclui 'conectando': worker pode ter reiniciado durante o processo de conexão
        const { data: conexoes } = await this.supabase
            .from('conexoes').select('conta_id').in('status', ['conectado', 'conectando']);
        if (!conexoes?.length)
            return;
        let allInstances = [];
        try {
            allInstances = await adminApi('GET', '/instance/all');
        }
        catch (err) {
            logger.error({ err }, 'uazapi: falha ao listar instâncias no startup');
            return;
        }
        for (const row of conexoes) {
            const contaId = row.conta_id;
            const name = instName(contaId);
            const inst = allInstances.find((i) => i.name === name);
            if (!inst) {
                await this.marcarDesconectado(contaId);
                continue;
            }
            this.instanceTokens.set(contaId, inst.token);
            if (inst.status === 'connected') {
                this.connected.add(contaId);
                // Sincronizar DB — pode estar em 'conectando' se o worker reiniciou durante conexão
                try {
                    const data = await instanceApi(inst.token, 'GET', '/instance/status');
                    const numero = data?.status?.jid?.user ?? null;
                    const nome = data?.instance?.profileName ?? null;
                    await this.supabase.from('conexoes').upsert({ conta_id: contaId, status: 'conectado', qr_code: null, comando: null,
                        numero_conectado: numero, device_name: nome,
                        ultima_conexao: new Date().toISOString() }, { onConflict: 'conta_id' });
                }
                catch { }
                this.iniciarPolling(contaId);
                logger.info({ contaId }, 'uazapi: sessão restaurada');
            }
            else {
                await this.marcarDesconectado(contaId);
            }
        }
    }
    // ── Criar instância + iniciar conexão + aguardar QR ──────────────────────────
    async conectar(contaId) {
        const name = instName(contaId);
        let token = this.instanceTokens.get(contaId);
        if (!token) {
            try {
                const data = await adminApi('POST', '/instance/create', { name });
                token = data.token;
                this.instanceTokens.set(contaId, token);
                logger.info({ contaId, name }, 'uazapi: instância criada');
            }
            catch (err) {
                // Instância pode já existir — tentar recuperar token via /instance/all
                try {
                    const all = await adminApi('GET', '/instance/all');
                    const inst = all.find((i) => i.name === name);
                    if (inst?.token) {
                        token = inst.token;
                        this.instanceTokens.set(contaId, token);
                        logger.info({ contaId }, 'uazapi: instância já existia — token recuperado');
                    }
                    else {
                        throw err;
                    }
                }
                catch {
                    logger.error({ contaId, err }, 'uazapi: falha ao criar instância');
                    throw err;
                }
            }
        }
        await this.supabase.from('conexoes').upsert({ conta_id: contaId, status: 'conectando', qr_code: null, comando: null }, { onConflict: 'conta_id' });
        // Inicia processo de conexão → gera QR code
        try {
            await instanceApi(token, 'POST', '/instance/connect');
        }
        catch (err) {
            logger.warn({ contaId, err }, 'uazapi: /instance/connect (pode já estar conectando)');
        }
        await sleep(2_000);
        await this.buscarEGravarQR(contaId);
        this.iniciarPolling(contaId);
    }
    // ── Logout ────────────────────────────────────────────────────────────────────
    async desconectar(contaId) {
        const token = this.instanceTokens.get(contaId);
        if (token) {
            try {
                await instanceApi(token, 'POST', '/instance/disconnect');
            }
            catch (err) {
                logger.warn({ contaId, err }, 'uazapi: disconnect (pode já estar desconectado)');
            }
        }
        this.connected.delete(contaId);
        this.polling.delete(contaId);
        await this.supabase.from('conexoes').upsert({ conta_id: contaId, status: 'desconectado', qr_code: null, comando: null,
            numero_conectado: null, device_name: null }, { onConflict: 'conta_id' });
    }
    // ── Reiniciar: sincroniza estado sem desconectar ──────────────────────────────
    async reconectar(contaId) {
        // Se token não está em memória (ex: worker reiniciou com conta em status desconectado
        // no banco mas instância ainda ativa no uazapi), recuperar via /instance/all antes
        // de checar o estado — caso contrário pegarEstado() retorna 'disconnected' sem verificar.
        if (!this.instanceTokens.has(contaId)) {
            try {
                const all = await adminApi('GET', '/instance/all');
                const inst = all.find((i) => i.name === instName(contaId));
                if (inst?.token) {
                    this.instanceTokens.set(contaId, inst.token);
                    logger.info({ contaId }, 'uazapi: token recuperado via /instance/all no reconectar');
                }
            }
            catch (err) {
                logger.warn({ contaId, err }, 'uazapi: falha ao recuperar token — tentando conectar()');
            }
        }
        // Checar estado real no uazapi antes de qualquer ação destrutiva
        let estadoAtual = 'disconnected';
        try {
            estadoAtual = await this.pegarEstado(contaId);
        }
        catch { }
        if (estadoAtual === 'connected') {
            // Já conectado — apenas sincronizar banco, sem desconectar
            const token = this.instanceTokens.get(contaId);
            if (token) {
                try {
                    const data = await instanceApi(token, 'GET', '/instance/status');
                    const numero = data?.status?.jid?.user ?? null;
                    const nome = data?.instance?.profileName ?? null;
                    await this.supabase.from('conexoes').upsert({ conta_id: contaId, status: 'conectado', qr_code: null, comando: null,
                        numero_conectado: numero, device_name: nome,
                        ultima_conexao: new Date().toISOString() }, { onConflict: 'conta_id' });
                }
                catch { }
            }
            this.connected.add(contaId);
            this.iniciarPolling(contaId);
            logger.info({ contaId }, 'uazapi: reiniciar — já conectado, banco sincronizado');
            return;
        }
        // Não conectado — iniciar nova conexão sem desconectar (preserva sessão se existir)
        this.connected.delete(contaId);
        this.polling.delete(contaId);
        await this.conectar(contaId);
    }
    // ── Enviar mensagem ───────────────────────────────────────────────────────────
    async enviarMensagem(contaId, para, texto, semDigitacao = false) {
        const token = this.instanceTokens.get(contaId);
        if (!token)
            throw new Error(`uazapi: sem token para conta ${contaId}`);
        if (!semDigitacao) {
            const ms = 7_000 + Math.floor(Math.random() * 2_000); // 7–9s
            try {
                // Presença async — cancelada automaticamente quando a mensagem é enviada
                await instanceApi(token, 'POST', '/message/presence', {
                    number: para, presence: 'composing', delay: ms,
                });
                await sleep(ms);
            }
            catch (err) {
                logger.warn({ contaId, err }, 'uazapi: falha no presence (não crítico)');
            }
        }
        await instanceApi(token, 'POST', '/send/text', { number: para, text: texto });
    }
    // ── Interface compartilhada ───────────────────────────────────────────────────
    hasSocket(contaId, _bypassWarmup = false) {
        return this.connected.has(contaId);
    }
    contasConectadas() {
        return this.connected.size;
    }
    // ── Privados ──────────────────────────────────────────────────────────────────
    async pegarEstado(contaId) {
        const token = this.instanceTokens.get(contaId);
        if (!token)
            return 'disconnected';
        try {
            const data = await instanceApi(token, 'GET', '/instance/status');
            if (data?.status?.connected === true)
                return 'connected';
            const s = data?.instance?.status ?? 'disconnected';
            if (s === 'connected')
                return 'connected';
            if (s === 'connecting')
                return 'connecting';
            return 'disconnected';
        }
        catch (err) {
            // 404 = instância deletada no uazapi → limpar token stale e retornar desconectado
            // (não lançar — o loop de polling detecta 'disconnected' e chama marcarDesconectado())
            if (/404/.test(String(err?.message ?? ''))) {
                this.instanceTokens.delete(contaId);
                return 'disconnected';
            }
            throw err;
        }
    }
    async buscarEGravarQR(contaId) {
        const token = this.instanceTokens.get(contaId);
        if (!token)
            return;
        try {
            const data = await instanceApi(token, 'GET', '/instance/status');
            const qr = data?.instance?.qrcode ?? null;
            if (qr) {
                await this.supabase.from('conexoes').upsert({ conta_id: contaId, qr_code: qr, status: 'conectando' }, { onConflict: 'conta_id' });
                logger.info({ contaId }, 'uazapi: QR gravado no banco');
            }
        }
        catch (err) {
            logger.warn({ contaId, err }, 'uazapi: erro ao buscar QR');
        }
    }
    async marcarDesconectado(contaId) {
        await this.supabase.from('conexoes').upsert({ conta_id: contaId, status: 'desconectado', qr_code: null, comando: null }, { onConflict: 'conta_id' });
    }
    // Polling de estado a cada 10s — circuit breaker após 10 erros consecutivos
    iniciarPolling(contaId) {
        if (this.polling.has(contaId))
            return;
        this.polling.add(contaId);
        const MAX_ERROS = 10;
        let erros = 0;
        const loop = async () => {
            while (this.polling.has(contaId)) {
                await sleep(10_000);
                try {
                    const state = await this.pegarEstado(contaId);
                    erros = 0; // reset no sucesso
                    if (state === 'connected' && !this.connected.has(contaId)) {
                        this.connected.add(contaId);
                        logger.info({ contaId }, 'uazapi: conectado!');
                        try {
                            const tok = this.instanceTokens.get(contaId);
                            const data = await instanceApi(tok, 'GET', '/instance/status');
                            const jid = data?.status?.jid;
                            const numero = jid?.user ?? null;
                            const nome = data?.instance?.profileName ?? null;
                            await this.supabase.from('conexoes').upsert({ conta_id: contaId, status: 'conectado', qr_code: null, comando: null,
                                numero_conectado: numero, device_name: nome,
                                ultima_conexao: new Date().toISOString() }, { onConflict: 'conta_id' });
                        }
                        catch { }
                    }
                    if (state !== 'connected' && this.connected.has(contaId)) {
                        this.connected.delete(contaId);
                        logger.warn({ contaId }, 'uazapi: perdeu conexão');
                        await this.marcarDesconectado(contaId);
                    }
                    if (state === 'connecting') {
                        await this.buscarEGravarQR(contaId);
                    }
                }
                catch (err) {
                    erros++;
                    logger.error({ contaId, err, erros }, 'uazapi: erro no polling');
                    if (erros >= MAX_ERROS) {
                        logger.error({ contaId }, 'uazapi: muitos erros consecutivos — parando polling');
                        this.polling.delete(contaId);
                        this.connected.delete(contaId);
                        try {
                            await this.marcarDesconectado(contaId);
                        }
                        catch { }
                        return;
                    }
                }
            }
        };
        loop();
    }
}
