// Utilitários de formatação para o worker (standalone, sem dep do Next.js).
export function formatBRL(value) {
    const n = typeof value === 'string' ? parseFloat(value) : value;
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
}
export function formatData(iso) {
    if (!iso)
        return '—';
    return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' })
        .format(new Date(iso.slice(0, 10) + 'T12:00:00'));
}
export function hojeEmSP() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}
export function addDias(dateStr, n) {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}
export function dentroDaJanela(horarioInicio = 9, horarioFim = 20) {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const hora = agora.getHours();
    return hora >= horarioInicio && hora < horarioFim;
}
export function intervalAleatorio(min = 45_000, max = 80_000) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
