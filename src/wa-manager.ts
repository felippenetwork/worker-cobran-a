// Interface comum para BaileysManager e UazapiManager.
// Os workers recebem IWAManager em vez de BaileysManager diretamente.

export interface IWAManager {
  restaurarSessoes(): Promise<void>
  conectar(contaId: string): Promise<void>
  desconectar(contaId: string): Promise<void>
  reconectar(contaId: string): Promise<void>
  enviarMensagem(contaId: string, para: string, texto: string, semDigitacao?: boolean): Promise<void>
  hasSocket(contaId: string, bypassWarmup?: boolean): boolean
  contasConectadas(): number
}
