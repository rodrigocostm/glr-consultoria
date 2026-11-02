// ============================================================
// GLR Consultoria — Adviser no Chat com os agentes
// ------------------------------------------------------------
// Ferramentas e instruções do Adviser quando o analista escolhe "Adviser" no
// chat (api/chat-central.js). O Adviser olha a GLR como empresa: receita de
// comissão até R$ 200 mil/mês (marcos 130/150/170), rentabilidade dos
// contratos, risco de cancelamento, expansão de canais, implantação de
// clientes e as missões da equipe. Só lê; registrar_missao grava uma missão
// em glr_storage glr_adviser (a mesma lista da tela Adviser) quando pedido.
// ============================================================
const { receitaProjecao } = require('./_adviser-revenue');
const { progresso, SYSTEM, MARCOS } = require('./_adviser');

const mesBRT = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7);
const r0 = v => Math.round(parseFloat(v) || 0);
const mesOk = m => /^20\d{2}-(0[1-9]|1[0-2])$/.test(m || '');

async function lerReceita(h, mes) {
  const [storage, base] = await Promise.all([
    h.sbSelect('glr_storage', 'chave=in.(glr_clientes,glr_projecoes,glr_mc_vinculos,glr_comissao_contas)&select=chave,dados'),
    h.sbSelect('glr_sync_estado', 'recurso=in.(resumo,pedidos)&marketplace=neq.sistema&select=marketplace,conta_id,recurso,cursor,ultimo_sucesso&limit=2000'),
  ]);
  const v = Object.fromEntries(storage.map(r => [r.chave, r.dados]));
  return receitaProjecao({ clientes: v.glr_clientes, projecoes: v.glr_projecoes, vinculos: v.glr_mc_vinculos, excecoes: v.glr_comissao_contas, base }, mes);
}
const sistemaCursor = async (h, conta, recurso) => (await h.sbSelect('glr_sync_estado', `marketplace=eq.sistema&conta_id=eq.${encodeURIComponent(conta)}&recurso=eq.${recurso}&select=cursor`).catch(() => []))[0]?.cursor || null;

async function receitaGlr(h, i) {
  const mes = mesOk(i?.mes) ? i.mes : mesBRT();
  const r = await lerReceita(h, mes), p = progresso(r.projetada);
  return { mes, receita_projetada: r.projetada == null ? null : r0(r.projetada), acumulado_ate_data_base: r.base == null ? null : r0(r.base), dias_fechados: r.dias, projecao_instavel: r.instavel,
    meta: p.meta, falta: p.falta == null ? null : r0(p.falta), proximo_marco: p.proximo, marcos: MARCOS, clientes_sem_dados: r.faltantes,
    por_cliente: r.detalhes.map(d => ({ cliente: d.cliente, receita_projetada: r0(d.receitaProjetada), fonte: d.fonte })).sort((a, b) => b.receita_projetada - a.receita_projetada),
    regra: 'Receita GLR = comissão pelo contrato de cada cliente (só contas comissão), projetada pelo ritmo do mês. Não é faturamento recebido nem conciliação.' };
}
async function rentabilidade(h, i) {
  const mes = mesOk(i?.mes) ? i.mes : mesBRT();
  const r = await lerReceita(h, mes);
  const ls = r.detalhes.filter(d => d.gmvProjetado > 0).map(d => ({ cliente: d.cliente, gmv_projetado: d.gmvProjetado, comissao_projetada: r0(d.receitaProjetada), taxa_pct: Math.round(d.receitaProjetada / d.gmvProjetado * 10000) / 100 }));
  const gmv = ls.reduce((s, x) => s + x.gmv_projetado, 0), com = ls.reduce((s, x) => s + x.comissao_projetada, 0), media = gmv ? com / gmv * 100 : 0;
  return { mes, taxa_media_pct: Math.round(media * 100) / 100, comissao_total: com, gmv_total: gmv,
    clientes: ls.map(x => ({ ...x, a_mais_na_media: Math.max(0, r0(x.gmv_projetado * media / 100 - x.comissao_projetada)) })).sort((a, b) => b.a_mais_na_media - a.a_mais_na_media),
    regra: 'taxa = comissão ÷ faturamento (GMV) do cliente. a_mais_na_media = quanto o contrato renderia se pagasse a taxa média da carteira — hipótese para renovação, não ganho garantido.' };
}
async function retencao(h) {
  const c = await sistemaCursor(h, 'retencao', 'todas');
  const ls = Object.values(c?.clientes || {}).filter(x => x.nivel !== 'ok').sort((a, b) => b.score - a.score);
  return { avaliado_em: c?.em || null, clientes_em_risco: ls.map(x => ({ cliente: x.nome, gestor: x.gestor, nivel: x.nivel, risco: x.score, var_14_dias_pct: x.var14, meta_pct: x.meta_pct, motivos: x.motivos.map(m => m.texto), plano: x.motivos.map(m => m.acao) })),
    regra: 'Agente de Retenção (07:00): risco 0–100 de o cliente cancelar; alto ≥ 50, médio ≥ 30.' };
}
async function expansao(h) {
  const rows = await h.sbSelect('glr_sync_estado', 'marketplace=eq.sistema&recurso=eq.expansao&select=cli:cursor->cliente,canais:cursor->canais,resumo:cursor->resumo,em:cursor->>em').catch(() => []);
  return { clientes: rows.filter(r => r.cli).map(r => ({ cliente: r.cli.nome, analisado_em: r.em, sem_conta_em: Object.entries(r.canais || {}).filter(([, x]) => !x.conta).map(([k]) => k),
    venda_nova_estimada_mes: r0(r.resumo?.receita_est), por_canal: Object.fromEntries(Object.entries(r.resumo?.porAlvo || {}).map(([k, x]) => [k, { produtos: x.n, venda_estimada_mes: r0(x.receita_est) }])) })).sort((a, b) => b.venda_nova_estimada_mes - a.venda_nova_estimada_mes),
    regra: 'Agente de Expansão de canais: produtos que já vendem num canal e faltam em outro. Estimativa otimista (soma todos os canais) — use para priorizar, não como previsão.' };
}
async function onboarding(h) {
  const c = await sistemaCursor(h, 'onboarding', 'todas');
  const cs = Object.values(c?.clientes || {});
  const porPasso = {}; for (const x of cs) for (const p of x.passos || []) if (!p.ok) porPasso[p.titulo] = (porPasso[p.titulo] || 0) + 1;
  return { verificado_em: c?.em || null, em_implantacao: cs.filter(x => x.implantacao).map(x => ({ cliente: x.nome, pronto_pct: x.pct, faltam: x.passos.filter(p => !p.ok).map(p => p.titulo) })), clientes_faltando_por_passo: porPasso };
}
async function lerAdviser(h) { return (await h.sbSelect('glr_storage', 'chave=eq.glr_adviser&select=dados').catch(() => []))[0]?.dados || {}; }
async function missoes(h) {
  const st = await lerAdviser(h);
  return { missoes: (st.missoes || []).filter(m => m.status !== 'concluida').map(m => ({ titulo: m.titulo, responsavel: m.responsavel, indicador: m.indicador, prazo: m.prazo, status: m.status, mes: m.mes })) };
}
async function registrarMissao(h, i) {
  const ok = s => typeof s === 'string' && s.trim();
  if (!ok(i.titulo) || i.titulo.length > 240 || !ok(i.responsavel) || i.responsavel.length > 100 || !ok(i.indicador) || i.indicador.length > 500 || !/^20\d{2}-\d{2}-\d{2}$/.test(i.prazo || '')) throw new Error('Preencha missão (até 240), responsável (até 100), indicador (até 500) e prazo AAAA-MM-DD.');
  if ((h.missoesCriadas = (h.missoesCriadas || 0) + 1) > 5) throw new Error('Limite de 5 missões por resposta.');
  const st = await lerAdviser(h);
  st.missoes ||= []; st.receitas ||= {};
  if (st.missoes.length >= 200) throw new Error('Limite de 200 missões atingido.');
  st.missoes.push({ id: require('node:crypto').randomUUID(), titulo: i.titulo.trim(), responsavel: i.responsavel.trim(), indicador: i.indicador.trim(), prazo: i.prazo, status: 'pendente', mes: mesBRT(), em: new Date().toISOString(), via: 'chat' });
  await h.sbUpsert('glr_storage', [{ chave: 'glr_adviser', dados: st, atualizado_em: new Date().toISOString() }], 'chave');
  return { ok: true, registrada: i.titulo.trim(), onde: 'tela Adviser → Missões da equipe' };
}

const MES = { type: 'string', description: 'AAAA-MM (padrão: mês atual)' };
const FERRAMENTAS = [
  { name: 'receita_glr', description: 'Receita GLR do mês (comissão projetada pelos contratos), acumulado, falta para R$ 200 mil, próximo marco e a receita de cada cliente. Comece por aqui.', input_schema: { type: 'object', properties: { mes: MES } } },
  { name: 'rentabilidade', description: 'Comissão ÷ faturamento de cada cliente e quanto cada contrato renderia na taxa média da carteira (base para revisão de contrato).', input_schema: { type: 'object', properties: { mes: MES } } },
  { name: 'retencao', description: 'Clientes em risco de cancelar (Agente de Retenção) com motivos e plano de recuperação.', input_schema: { type: 'object', properties: {} } },
  { name: 'expansao', description: 'Venda nova estimada por cliente levando produtos a canais onde ainda não estão (Agente de Expansão de canais).', input_schema: { type: 'object', properties: {} } },
  { name: 'onboarding', description: 'Clientes em implantação e o que falta no checklist (contas, vendas na base, comissão, custos, agente de ADS…).', input_schema: { type: 'object', properties: {} } },
  { name: 'missoes', description: 'Missões abertas da equipe registradas no Adviser.', input_schema: { type: 'object', properties: {} } },
  { name: 'registrar_missao', description: 'Registra UMA missão na lista do Adviser. Use só quando o analista pedir para registrar/criar missões. Até 5 por resposta.', input_schema: { type: 'object', properties: { titulo: { type: 'string' }, responsavel: { type: 'string' }, indicador: { type: 'string', description: 'indicador e critério de sucesso verificável' }, prazo: { type: 'string', description: 'AAAA-MM-DD' } }, required: ['titulo', 'responsavel', 'indicador', 'prazo'] } },
];
const EXEC = { receita_glr: receitaGlr, rentabilidade, retencao, expansao, onboarding, missoes, registrar_missao: registrarMissao };
const ROTULO = { receita_glr: 'receita GLR', rentabilidade: 'rentabilidade', retencao: 'retenção', expansao: 'expansão de canais', onboarding: 'implantação', missoes: 'missões', registrar_missao: 'missão registrada' };

function sistema(hoje, clientes) {
  return `${SYSTEM}

AGORA VOCÊ ESTÁ NUMA CONVERSA no Chat com os agentes, com um analista da GLR. Hoje é ${hoje} (Brasília). Clientes da carteira: ${clientes.join(', ')}.
- Responda à pergunta feita, com a conclusão primeiro e os números que a sustentam (diga o mês e a fonte). Use a estrutura completa (diagnóstico, rota, até 5 missões, decisão da semana) só quando pedirem estratégia, plano ou rota.
- Busque os números com as ferramentas antes de responder (receita_glr, rentabilidade, retencao, expansao, onboarding, missoes; e carteira, plano_cliente e vendas para olhar um cliente). Nunca invente número.
- Registre missões com registrar_missao só quando o analista pedir; diga quantas registrou. Você não executa campanha, preço, contrato nem mensagem.
- Use tabelas em markdown quando comparar clientes. Português do Brasil, direto.`;
}

module.exports = { FERRAMENTAS, EXEC, ROTULO, sistema };
