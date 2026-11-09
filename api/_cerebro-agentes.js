// ============================================================
// GLR Consultoria — os agentes escrevendo no Segundo Cérebro
// ------------------------------------------------------------
// Todo dia, logo depois do plano do Gerente de Conta, cada cliente ganha (ou
// atualiza) a nota "Agentes · <Cliente>" com o que a equipe de agentes sabe e
// aprendeu sobre ele — só a partir de dados registrados, sem IA:
//  • situação do mês (Gerente de Conta)
//  • o que funcionou e o que não funcionou no ADS (medição 7 dias antes × depois)
//  • estoque e margem, reputação e qualidade dos anúncios
// E a nota-índice "Agentes · Carteira" liga todas com [[links]] e soma o
// placar de cada tipo de ajuste na carteira inteira.
// As notas são publicadas (os agentes passam a consultá-las nas respostas);
// se alguém arquivar ou voltar a nota para rascunho, o estado é respeitado.
// O texto da nota é dos agentes e é reescrito a cada dia — observações da
// equipe vão em outra nota, ligada com [[Agentes · <Cliente>]].
// Também: anotar() — usado pelo chat quando o analista pede "anota que…".
// ============================================================
const { db } = require('./_conhecimento');

const AUTOR_AGENTES = '00000000-0000-4000-8000-00000000a6e7'; // atualizado_por das notas escritas pelos agentes
const HUB = 'Agentes · Carteira';
const tituloCliente = nome => `Agentes · ${String(nome || '').replace(/[\[\]\n\r]/g, ' ').trim()}`.slice(0, 160);
const R$ = v => 'R$ ' + Math.round(parseFloat(v) || 0).toLocaleString('pt-BR');
const pct = v => v == null || !isFinite(v) ? '—' : `${(Math.round(v * 10) / 10).toLocaleString('pt-BR')}%`;
const corta = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const dm = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' }); };
const agoraTxt = () => new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
const semLinks = s => String(s || '').replace(/\[\[|\]\]/g, '');
const ATUALIZADO = /^_?Atualizado pelos agentes em [^\n]*$/m; // a data da atualização não conta como mudança

// Tipo de ajuste de ADS (para o placar do que funciona)
function tipoAjuste(l) {
  const d = l.dados || {}, t = String(l.titulo || '');
  if (d.roas_de != null && d.roas_para != null) return +d.roas_para < +d.roas_de ? 'Baixar a meta de ROAS (lance mais forte)' : 'Subir a meta de ROAS (conter)';
  if (d.budget_de != null && d.budget_para != null) return +d.budget_para > +d.budget_de ? 'Aumentar orçamento' : 'Reduzir orçamento';
  if (/pausad|pausar/i.test(t)) return 'Pausar campanha';
  if (/retom|reativ/i.test(t)) return 'Reativar campanha';
  if (d.marketplace === 'ml' || /^Sugestão/.test(t)) return 'Sugestão do Copiloto ML aplicada';
  return 'Outro ajuste';
}
const medicoes = (medidos, contas) => medidos
  .filter(l => contas.has(String(l.conta_id)) && ['melhorou', 'piorou', 'neutro'].includes(l.dados?.medicao?.veredito))
  .sort((a, b) => String(b.dados.medicao.medido_em || '').localeCompare(String(a.dados.medicao.medido_em || '')));
function placar(lista) {
  const por = {};
  for (const l of lista) { const k = tipoAjuste(l), p = por[k] || (por[k] = { n: 0, melhorou: 0, piorou: 0 }); p.n++; if (l.dados.medicao.veredito === 'melhorou') p.melhorou++; if (l.dados.medicao.veredito === 'piorou') p.piorou++; }
  return Object.entries(por).sort((a, b) => b[1].n - a[1].n);
}

function notaCliente(c, plano, lojas, medidos) {
  const m = plano.metricas || {};
  const contas = new Set(lojas.map(L => String(L.conta)));
  const nomeLoja = id => lojas.find(L => String(L.conta) === String(id))?.nome || id;
  const med = medicoes(medidos, contas);
  const L = [];
  L.push(`# ${semLinks(c.nome)} — o que os agentes sabem`, '');
  L.push(`Atualizado pelos agentes em ${agoraTxt()}.`, '');
  L.push(`Nota escrita e reescrita todo dia pelos agentes a partir dos dados registrados. Observações da equipe: crie outra nota e cite o título desta entre colchetes duplos para ligar as duas. Visão da carteira: [[${HUB}]].`, '');

  L.push('## Situação do mês (Gerente de Conta)');
  L.push(`- Projeção: **${R$(m.projecao)}**${m.meta ? ` — ${pct(m.pctMeta)} da meta de ${R$(m.meta)}` : ' (sem meta cadastrada)'}${m.varMes != null ? ` · ${m.varMes >= 0 ? '+' : ''}${pct(m.varMes)} contra o mesmo período do mês passado` : ''}.`);
  if (m.tacos != null) L.push(`- TACOS do mês: **${pct(m.tacos)}**${m.metaTacos ? ` (${m.tetoTacos ? 'teto' : 'meta'} ${pct(m.metaTacos)} — ${m.tacos <= m.metaTacos ? 'dentro' : 'acima'})` : ''}.`);
  L.push(`- Semáforo de hoje: **${plano.semaforo}**.`);
  if (plano.diagnostico) L.push(`- Diagnóstico: ${corta(semLinks(plano.diagnostico), 700)}`);
  const acoes = (plano.acoes || []).slice(0, 4);
  if (acoes.length) { L.push('- Prioridades do plano:'); acoes.forEach(a => L.push(`  - ${corta(semLinks(a.titulo), 120)}${a.impacto ? ` (${corta(a.impacto, 40)})` : ''}`)); }
  L.push('');

  L.push('## ADS — o que funcionou e o que não funcionou');
  if (!med.length) L.push('Nenhum ajuste medido nos últimos 45 dias (cada ajuste é medido 7 dias depois: 7 dias antes × 7 depois).');
  else {
    const pl = placar(med);
    L.push(`Placar dos ajustes medidos nos últimos 45 dias (7 dias antes × 7 depois): **${med.length}** medidos, **${med.filter(l => l.dados.medicao.veredito === 'melhorou').length}** melhoraram, **${med.filter(l => l.dados.medicao.veredito === 'piorou').length}** pioraram.`);
    pl.forEach(([k, p]) => L.push(`- ${k}: ${p.melhorou} de ${p.n} melhoraram${p.piorou ? `, ${p.piorou} pioraram` : ''}.`));
    const linha = l => `- ${l.dados.medicao.veredito === 'melhorou' ? 'Funcionou' : l.dados.medicao.veredito === 'piorou' ? 'Não funcionou' : 'Sem efeito claro'}: ${corta(semLinks(String(l.titulo).replace(/^Sugestão: /, '')), 90)} (${nomeLoja(l.conta_id)}) — ${corta(semLinks(l.dados.medicao.resumo), 160)} · medido em ${dm(l.dados.medicao.medido_em)}`;
    const bons = med.filter(l => l.dados.medicao.veredito === 'melhorou').slice(0, 6), ruins = med.filter(l => l.dados.medicao.veredito === 'piorou').slice(0, 4);
    if (bons.length) { L.push('', '**Exemplos que funcionaram:**'); bons.forEach(l => L.push(linha(l))); }
    if (ruins.length) { L.push('', '**Exemplos que não funcionaram (evitar repetir):**'); ruins.forEach(l => L.push(linha(l))); }
  }
  L.push('');

  const est = [];
  for (const lj of lojas) {
    const r = lj.sinais?.resumo, d = lj.sinais?.destaques || {};
    if (!r) continue;
    const p = [];
    if (r.zerados) p.push(`${r.zerados} sem estoque${d.zerados?.length ? ` (ex.: ${corta(semLinks(d.zerados[0]), 50)})` : ''}`);
    if (r.criticos) p.push(`${r.criticos} acabam em até 7 dias${d.criticos?.length ? ` (ex.: ${corta(semLinks(d.criticos[0].n), 50)}, ~${Math.round(d.criticos[0].d)} d)` : ''}`);
    if (r.negativos) p.push(`${r.negativos} com margem negativa${d.negativos?.length ? ` (ex.: ${corta(semLinks(d.negativos[0].n), 50)}, ${String(d.negativos[0].m).replace('.', ',')}%)` : ''}`);
    if (r.produtos && r.comCusto != null && r.produtos - r.comCusto > 0) p.push(`${r.produtos - r.comCusto} produto(s) vendendo sem custo cadastrado`);
    est.push(`- ${lj.nome || lj.conta} (${lj.mkt === 'ml' ? 'Mercado Livre' : 'Shopee'}): ${p.length ? p.join('; ') : `${r.produtos || 0} produtos conferidos, sem alerta`}.`);
  }
  L.push('## Estoque e margem (Estoque · Margem)'); L.push(...(est.length ? est : ['Sem cálculo recente de estoque e margem.'])); L.push('');

  const rq = [];
  for (const lj of lojas) {
    const r = lj.reputacao?.resumo, q = lj.qualidade?.resumo, qd = lj.qualidade?.destaques || {};
    const p = [];
    if (r?.risco === 'alto') p.push(`reputação em risco${r.riscoMotivo ? ` (${corta(r.riscoMotivo, 80)})` : ''}`);
    else if (r?.nivel) p.push(`reputação ${String(r.nivel).toLowerCase()}`);
    if (r?.produtosProblema) p.push(`${r.produtosProblema} produto(s) com reclamação repetida`);
    if (q?.ruins) p.push(`${q.ruins} anúncio(s) a consertar${qd.ruins?.[0] ? ` (ex.: ${corta(semLinks(qd.ruins[0].n), 45)}: ${corta(semLinks(qd.ruins[0].qa), 80)})` : ''}`);
    if (p.length) rq.push(`- ${lj.nome || lj.conta}: ${p.join('; ')}.`);
  }
  L.push('## Reputação e qualidade dos anúncios'); L.push(...(rq.length ? rq : ['Nada a apontar no último levantamento.']));
  return L.join('\n').slice(0, 39000);
}

function notaHub(planos, medidosTodos, contasTodas) {
  const med = medicoes(medidosTodos, contasTodas);
  const L = [`# Agentes · Carteira`, '', `Atualizado pelos agentes em ${agoraTxt()}.`, '',
    'Índice das notas que os agentes mantêm por cliente, e o placar do que funciona no ADS na carteira inteira (cada ajuste medido 7 dias antes × 7 depois).', '',
    '## O que funciona no ADS (carteira, últimos 45 dias)'];
  if (!med.length) L.push('Nenhum ajuste medido ainda.');
  else placar(med).forEach(([k, p]) => L.push(`- ${k}: ${p.melhorou} de ${p.n} melhoraram (${pct(p.melhorou / p.n * 100)})${p.piorou ? `, ${p.piorou} pioraram` : ''}.`));
  L.push('', '## Clientes');
  const ord = { vermelho: 0, amarelo: 1, verde: 2 };
  planos.slice().sort((a, b) => (ord[a.semaforo] ?? 3) - (ord[b.semaforo] ?? 3) || a.nome.localeCompare(b.nome)).forEach(p =>
    L.push(`- [[${tituloCliente(p.nome)}]] — ${p.semaforo}${p.pctMeta != null ? ` · ${pct(p.pctMeta)} da meta` : ''}${p.tacos != null ? ` · TACOS ${pct(p.tacos)}` : ''}`));
  return L.join('\n').slice(0, 39000);
}

// Cria ou atualiza uma nota dos agentes (só grava se o conteúdo mudou além da data)
async function gravar(titulo, conteudo, tags, { anexar = false, estadoNovo = 'publicado', categoria = 'Aprendizados' } = {}) {
  const enc = encodeURIComponent(titulo.replace(/[%_\\]/g, c => '\\' + c));
  const old = (await db(`?titulo=ilike.${enc}&select=*`))[0];
  if (old) {
    const novo = anexar ? `${old.conteudo}\n\n${conteudo}`.slice(-39000) : conteudo;
    if (!anexar && String(old.conteudo).replace(ATUALIZADO, '') === novo.replace(ATUALIZADO, '')) return { titulo, mudou: false };
    const historico = [...(old.historico || []), Object.fromEntries(Object.entries(old).filter(([k]) => k !== 'historico'))].slice(anexar ? -50 : -20);
    const row = { conteudo: novo, tags: [...new Set([...(old.tags || []), ...tags])].slice(0, 12), versao: old.versao + 1, historico, atualizado_em: new Date().toISOString(), atualizado_por: AUTOR_AGENTES };
    const r = await db(`?id=eq.${old.id}&versao=eq.${old.versao}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    return { titulo, mudou: !!r?.length, id: old.id };
  }
  const id = require('crypto').randomUUID();
  await db('', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ id, titulo, conteudo: conteudo.slice(0, 39000), categoria, tags: tags.slice(0, 12), estado: estadoNovo, versao: 1, historico: [], atualizado_em: new Date().toISOString(), atualizado_por: AUTOR_AGENTES }) });
  return { titulo, mudou: true, id, nova: true };
}

// Chamado pelo Gerente de Conta depois de montar o plano de cada cliente
async function anotarCliente(c, plano, lojas, medidos) {
  return gravar(tituloCliente(c.nome), notaCliente(c, plano, lojas, medidos), ['agentes', 'cliente', ...new Set(lojas.map(L => L.mkt === 'ml' ? 'mercado livre' : 'shopee'))]);
}
async function anotarCarteira(planos, medidos, contas) {
  return gravar(HUB, notaHub(planos, medidos, contas), ['agentes', 'carteira', 'ads']);
}

// "Anota que…" no chat: cria a nota ou acrescenta um trecho datado no fim dela
async function anotar({ titulo, texto, autor, tags = [] }) {
  const t = String(titulo || '').replace(/[\[\]\n\r]/g, ' ').trim().slice(0, 160);
  const corpo = String(texto || '').trim().slice(0, 8000);
  if (!t || !corpo) throw new Error('Diga o título e o que anotar.');
  const bloco = `## ${agoraTxt()} — ${String(autor || 'agente').slice(0, 60)}\n${corpo}`;
  return gravar(t, bloco, ['agentes', ...tags.map(x => String(x).slice(0, 40))].slice(0, 12), { anexar: true, categoria: 'Aprendizados' });
}

module.exports = { anotarCliente, anotarCarteira, anotar, notaCliente, notaHub, tituloCliente, tipoAjuste, HUB };
