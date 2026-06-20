// Resolução e substituição de variáveis de template.
// Variáveis (notificacoes-fila §3): #VALOR# #NOMECOMPLETO# #NOME# #PIX# #SAUDACAO# #VENCIMENTO#

import { formatBRL, formatData } from './format.js'
import type { SupabaseAdmin } from './supabase.js'

export function substituirVariaveis(
  template: string,
  vars: { valor: string; nomecompleto: string; nome: string; pix: string; saudacao: string; vencimento: string },
): string {
  return template
    .replace(/#VALOR#/g,         vars.valor)
    .replace(/#NOMECOMPLETO#/g,  vars.nomecompleto)
    .replace(/#NOME#/g,          vars.nome)
    .replace(/#PIX#/g,           vars.pix)
    .replace(/#SAUDACAO#/g,      vars.saudacao)
    .replace(/#VENCIMENTO#/g,    vars.vencimento)
}

export async function resolverVariaveis(
  supabase: SupabaseAdmin,
  { contaId, parcelaId, clienteId, template }: {
    contaId: string; parcelaId: string; clienteId: string; template: string
  },
): Promise<string> {
  const [
    { data: parcela },
    { data: cliente },
    { data: pix },
    { data: saudacoes },
  ] = await Promise.all([
    supabase.from('parcelas').select('valor, data_vencimento').eq('id', parcelaId).single(),
    supabase.from('clientes').select('nome, sobrenome').eq('id', clienteId).single(),
    supabase.from('meios_pagamento').select('mensagem').eq('conta_id', contaId).eq('is_padrao', true).maybeSingle(),
    supabase.from('saudacoes').select('texto').eq('conta_id', contaId),
  ])

  const textos   = (saudacoes ?? []).map((s: any) => s.texto as string)
  const saudacao = textos.length ? textos[Math.floor(Math.random() * textos.length)] : 'Olá!'

  return substituirVariaveis(template, {
    valor:        formatBRL(parseFloat((parcela as any)?.valor ?? '0')),
    nomecompleto: `${(cliente as any)?.nome ?? ''} ${(cliente as any)?.sobrenome ?? ''}`.trim(),
    nome:         (cliente as any)?.nome ?? '',
    pix:          (pix as any)?.mensagem ?? '(Pix não configurado)',
    saudacao,
    vencimento:   formatData((parcela as any)?.data_vencimento),
  })
}
