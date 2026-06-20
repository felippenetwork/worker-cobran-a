export type ConexaoStatus = 'conectado' | 'desconectado' | 'conectando'

export type Conexao = {
  id:               string
  conta_id:         string
  status:           ConexaoStatus
  numero_conectado: string | null
  device_name:      string | null
  session_ref:      string | null
  qr_code:          string | null
  comando:          string | null
  ultima_conexao:   string | null
}
