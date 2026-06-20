// Worker de E-mail via Resend.
// Regras (notificacoes-fila §5):
//   • Janela 09:00–20:00 (SP). Overflow → dia seguinte às 09h.
//   • Sem o intervalo longo do WhatsApp (sem risco de ban), apenas rate limit do Resend.
//   • Todo e-mail DEVE ter link de unsubscribe no rodapé (§2, §8).
//   • Não enviar para clientes com optout_email = true.

import pino from 'pino'
import { Resend } from 'resend'
import { dentroDaJanela, sleep, hojeEmSP, addDias } from '../format.js'
import { resolverVariaveis } from '../variaveis.js'
import type { SupabaseAdmin } from '../supabase.js'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' })
const resend  = new Resend(process.env.RESEND_API_KEY)

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'

export async function processarFilaEmail(supabase: SupabaseAdmin) {
  if (!dentroDaJanela()) return

  const agora = new Date().toISOString()

  const { data: pendentes } = await supabase
    .from('notificacoes_enviadas')
    .select('id, conta_id, parcela_id, cliente_id, tipo')
    .eq('canal', 'email')
    .eq('status', 'fila')
    .lte('agendado_para', agora)
    .order('agendado_para', { ascending: true })
    .limit(10)

  for (const notif of pendentes ?? []) {
    await processarUmEmail(supabase, notif)
    await sleep(2_000)  // pequena pausa para respeitar rate limit do Resend
  }
}

async function processarUmEmail(
  supabase: SupabaseAdmin,
  notif: { id: string; conta_id: string; parcela_id: string | null; cliente_id: string; tipo: string },
) {
  const contaId = notif.conta_id

  // Verificar optout_email
  const { data: cliente } = await supabase
    .from('clientes')
    .select('nome, sobrenome, email, optout_email')
    .eq('id', notif.cliente_id)
    .single()

  if (!cliente || (cliente as any).optout_email) {
    await supabase.from('notificacoes_enviadas').update({ status: 'cancelado' }).eq('id', notif.id)
    return
  }

  // Buscar config de notificação
  const { data: cfg } = await supabase
    .from('notificacoes_config')
    .select('template_email, assunto_email')
    .eq('conta_id', contaId)
    .eq('tipo', notif.tipo)
    .single()

  const template = (cfg as any)?.template_email
  const assunto  = (cfg as any)?.assunto_email
  if (!template || !assunto) {
    await supabase.from('notificacoes_enviadas').update({ status: 'falhou' }).eq('id', notif.id)
    return
  }

  // Buscar remetente
  const [{ data: remConfig }, { data: platConfig }] = await Promise.all([
    supabase.from('email_remetente').select('local_part, from_name').eq('conta_id', contaId).maybeSingle(),
    supabase.from('plataforma_config').select('dominio_email_operador').single(),
  ])

  const localPart = (remConfig as any)?.local_part
  const dominio   = (platConfig as any)?.dominio_email_operador
  if (!localPart || !dominio) {
    await supabase.from('notificacoes_enviadas').update({ status: 'falhou' }).eq('id', notif.id)
    return
  }

  const fromName    = (remConfig as any)?.from_name ?? localPart
  const fromAddress = `${fromName} <${localPart}@${dominio}>`
  const toAddress   = (cliente as any).email
  const unsubUrl    = `${SITE_URL}/descadastrar/${notif.cliente_id}`

  // Resolver variáveis
  let conteudoFinal: string
  try {
    conteudoFinal = await resolverVariaveis(supabase, {
      contaId,
      parcelaId: notif.parcela_id ?? notif.id,
      clienteId: notif.cliente_id,
      template,
    })
  } catch (err) {
    logger.error({ notifId: notif.id, err }, 'Email: erro ao resolver variáveis')
    await supabase.from('notificacoes_enviadas').update({ status: 'falhou' }).eq('id', notif.id)
    return
  }

  // Montar HTML com unsubscribe obrigatório (notificacoes-fila §2, §8)
  const html = gerarHTMLEmail({ assunto, conteudo: conteudoFinal, fromName, unsubscribeUrl: unsubUrl })

  try {
    const { data: resendData, error: resendErr } = await resend.emails.send({
      from:    fromAddress,
      to:      toAddress,
      subject: assunto,
      html,
      headers: { 'List-Unsubscribe': `<${unsubUrl}>` },
    })

    if (resendErr) throw resendErr

    await supabase.from('notificacoes_enviadas').update({
      status:            'enviado',
      mensagem_final:    conteudoFinal,
      enviado_em:        new Date().toISOString(),
      resend_message_id: resendData?.id ?? null,
    }).eq('id', notif.id)

    logger.info({ notifId: notif.id, resendId: resendData?.id }, 'Email: enviado')
  } catch (err) {
    logger.error({ notifId: notif.id, err }, 'Email: erro ao enviar')
    if (!dentroDaJanela()) {
      const amanha = addDias(hojeEmSP(), 1)
      await supabase.from('notificacoes_enviadas')
        .update({ agendado_para: new Date(`${amanha}T09:00:00-03:00`).toISOString() })
        .eq('id', notif.id)
    } else {
      await supabase.from('notificacoes_enviadas').update({ status: 'falhou' }).eq('id', notif.id)
    }
  }
}

// Template HTML mínimo com unsubscribe (deve estar no rodapé de todo e-mail — §8)
function gerarHTMLEmail({ assunto, conteudo, fromName, unsubscribeUrl }: {
  assunto: string; conteudo: string; fromName: string; unsubscribeUrl: string
}): string {
  const corpo = conteudo.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${assunto}</title></head><body style="font-family:Arial,sans-serif;background:#f4f5f7;margin:0;padding:0">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:8px;border:1px solid #e2e8f0;overflow:hidden">
<div style="background:#0B0F17;padding:20px 28px"><span style="color:#E6EAF2;font-size:16px;font-weight:600">${fromName}</span></div>
<div style="padding:28px;color:#1a202c;font-size:15px;line-height:1.65">${corpo}</div>
<div style="padding:16px 28px;background:#f7fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#718096">
<p>Enviado por <strong>${fromName}</strong>.</p>
<p style="margin-top:8px">Para não receber mais e-mails, <a href="${unsubscribeUrl}" style="color:#718096">clique aqui para se descadastrar</a>.</p>
</div></div></body></html>`
}
