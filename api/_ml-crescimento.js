// Motor de escala: cálculos determinísticos; IA apenas escolhe propostas elegíveis.
const GRUPOS = ['escalar', 'destravar', 'desenvolver', 'conter'];
const pos = v => v !== '' && v != null && Number.isFinite(+v) && +v > 0 ? +v : null;
const percentual = v => pos(v) != null && +v < 100 ? +v : null;
const arred = n => Math.round(n * 100) / 100;
function configurar(raw = {}, cfg = {}) {
  const margem = raw.margem_reserva != null && raw.margem_reserva !== '' && Number.isFinite(+raw.margem_reserva) && +raw.margem_reserva >= 0 && +raw.margem_reserva < 100 ? +raw.margem_reserva : null;
  return { versao: 1, piloto: raw.piloto === true, meta_acos: percentual(cfg.meta_acos), teto_tacos: percentual(raw.teto_tacos) || percentual(cfg.teto_tacos),
    meta_faturamento: pos(raw.meta_faturamento), margem_reserva: margem,
    passo_max: Math.min(25, Math.max(5, pos(raw.passo_max) || 15)),
    limites_grupo: Object.fromEntries(GRUPOS.map(g => [g, percentual(raw.limites_grupo?.[g])])) };
}
function classificar(f, aviso, config) {
  const aa = aviso?.aa != null && Number.isFinite(+aviso.aa) ? +aviso.aa : null;
  const estoques = aviso && (aviso.estoque != null || aviso.dias != null || aviso.ne != null);
  const bloqueios = [];
  if (!config.meta_acos) bloqueios.push('Definir meta de ACOS');
  if (!config.teto_tacos) bloqueios.push('Definir teto de TACOS separado');
  if (aa == null) bloqueios.push('Margem antes do ADS indisponível');
  if (config.margem_reserva == null) bloqueios.push('Definir margem mínima após ADS');
  if (!estoques) bloqueios.push('Estoque sem informação');
  const margemLim = aa == null || config.margem_reserva == null ? null : aa - config.margem_reserva;
  const limite = Math.min(config.meta_acos || Infinity, margemLim ?? Infinity);
  const acos = f.vendasAj > 0 ? f.gasto / f.vendasAj * 100 : null;
  let grupo = 'desenvolver';
  if (aviso?.ne === 'zerado' || (aa != null && aa <= 0) || (margemLim != null && margemLim <= 0)) grupo = 'conter';
  else if (f.semBuybox || aviso?.qa || aviso?.rp || aviso?.ne === 'critico' || (aviso?.dias != null && aviso.dias <= 10)) grupo = 'destravar';
  else if (f.unidades >= 3 && acos != null && Number.isFinite(limite) && acos > limite) grupo = 'conter';
  else if (!bloqueios.length && f.unidades >= 3 && f.cliques >= 30 && acos != null && acos <= limite) grupo = 'escalar';
  const limiteGrupo = config.limites_grupo[grupo];
  const limiteFinal = Math.min(limite, limiteGrupo || Infinity);
  if (grupo === 'escalar' && acos > limiteFinal) grupo = 'conter';
  const evidencia = f.cliques >= 200 && f.unidades >= 10 ? 'alta' : f.cliques >= 30 && f.unidades >= 3 ? 'media' : 'baixa';
  const confianca = bloqueios.length ? 'baixa' : evidencia;
  return { grupo, limite_acos: Number.isFinite(limiteFinal) ? Math.max(0, arred(limiteFinal)) : null, margem_antes_ads: aa,
    confianca, bloqueios, motivo: grupo === 'escalar' ? 'Venda comprovada, margem e estoque disponíveis' : grupo === 'destravar' ? 'Resolver oferta, Buy Box, estoque ou reputação' : grupo === 'conter' ? 'Proteger a contribuição antes de ampliar exposição' : 'Reunir histórico e dados antes de escalar' };
}
function passo(contexto, config) {
  if (!contexto || contexto.grupo !== 'escalar' || contexto.confianca === 'baixa') return 0;
  return Math.min(config.passo_max, contexto.confianca === 'alta' ? 20 : 10) / 100;
}
function experimento(d, contexto, config, mensal = {}) {
  const escala = (d.acao === 'orcamento' && +d.para > +d.de) || (d.acao === 'roas_target' && +d.para < +d.de) || d.acao === 'adicionar_produto';
  const pronto = !!(contexto && contexto.grupo === 'escalar' && config.meta_faturamento && config.margem_reserva != null && config.teto_tacos && mensal.tacos != null && mensal.tacos < config.teto_tacos && mensal.cobertura && !mensal.bloqueado);
  if (escala && !pronto) return { bloqueado: true, motivo: contexto?.bloqueios?.join('; ') || 'Sem folga de TACOS, estoque ou amostra suficiente' };
  const novo = { ...d };
  if (escala && config.piloto && ['orcamento', 'roas_target'].includes(d.acao)) {
    const p = passo(contexto, config);
    if (!p || !(+d.de > 0)) return { bloqueado: true, motivo: 'Sem dados para dimensionar o teste' };
    novo.para = d.acao === 'orcamento' ? Math.floor(Math.min(+d.para, +d.de * (1 + p))*100+1e-8)/100 : Math.ceil(Math.max(+d.para, +d.de * (1 - p), 100 / contexto.limite_acos)*100-1e-8)/100;
    if ((d.acao === 'orcamento' && novo.para <= +d.de) || (d.acao === 'roas_target' && novo.para >= +d.de)) return { bloqueado: true, motivo: 'Meta de ROAS já no limite da margem' };
  }
  if (escala && ['orcamento','roas_target'].includes(d.acao) && Math.abs(+d.para - +d.de) > 0 && d.impacto != null) novo.impacto = Math.max(0,+d.impacto) * Math.min(1, Math.abs(novo.para-d.de)/Math.abs(d.para-d.de));
  const margem = contexto?.margem_antes_ads;
  // Ganho de GMV é hipótese; sem margem conhecida não vira lucro inventado.
  const contribuicao = d.impacto_tipo === 'economia' ? Math.max(0, +d.impacto || 0)
    : margem != null && contexto?.limite_acos != null ? Math.max(0, (+novo.impacto || 0) * (margem - contexto.limite_acos) / 100) : null;
  novo.crescimento = { ...contexto, contribuicao_hipotese: contribuicao == null ? null : arred(contribuicao), estimativa: true, escala };
  const pesoMeta = escala && config.meta_faturamento && mensal.projecao != null ? 1 + Math.min(.5, Math.max(0, 1 - mensal.projecao / config.meta_faturamento)) : 1;
  novo.prioridade = arred(pesoMeta * (contribuicao || 0) * ({ alta: 1, media: .6, baixa: .2 }[contexto?.confianca] || .2));
  if (config.piloto) novo.experimento = { versao: 1, hipotese: escala ? 'Ampliar faturamento total preservando contribuição após ADS' : 'Reduzir desperdício preservando faturamento total',
    antes: +d.de || null, depois: +novo.para || null, meta_acos: contexto?.limite_acos || config.meta_acos, teto_tacos: config.teto_tacos,
    margem_antes_ads: margem ?? null, margem_reserva: config.margem_reserva,
    meta_faturamento: config.meta_faturamento, projecao_inicial: mensal.projecao ?? null,
    criterio_recuo: 'Reavaliar se ultrapassar o teto de TACOS, perder contribuição estimada ou faltar estoque. Recuo depende da revisão do gestor.',
    janela_dias: 7, maturacao_dias: 14, medir_apos_dias: 21, observacional: true, requer_aprovacao: true };
  return { dados: novo, escala };
}
function medir(antes, depois, exp, eventos = [], sobreposta = false) {
  const calc = m => !m || m.total == null || m.ads == null || !Number.isFinite(+m.total) || !Number.isFinite(+m.ads) || +m.total < 0 || +m.ads < 0 ? null : { faturamento: +m.total || 0, ads: +m.ads || 0,
    tacos: m.total > 0 ? arred(m.ads / m.total * 100) : null,
    contribuicao_estimada: exp.margem_antes_ads == null ? null : arred(m.total * exp.margem_antes_ads / 100 - m.ads) };
  const a=calc(antes), b=calc(depois);
  const confundida = sobreposta || eventos.length > 0;
  const veredito = !a || !b || a.contribuicao_estimada == null || !exp.teto_tacos || (a && a.faturamento <= 0) || confundida ? 'inconclusivo'
    : b.faturamento === 0 || (exp.margem_reserva != null && b.contribuicao_estimada / b.faturamento * 100 < exp.margem_reserva) ? 'piorou' : b.contribuicao_estimada > a.contribuicao_estimada && b.faturamento >= a.faturamento && b.tacos <= exp.teto_tacos ? 'melhorou'
    : b.contribuicao_estimada < a.contribuicao_estimada || b.tacos > exp.teto_tacos ? 'piorou' : 'neutro';
  return { antes:a, depois:b, veredito, eventos, sobreposta, observacional:true,
    resumo: !a || !b ? 'Sem cobertura para medir o período completo' : `Faturamento total ${arred(a.faturamento)} → ${arred(b.faturamento)}; contribuição estimada ${a.contribuicao_estimada ?? 'sem margem'} → ${b.contribuicao_estimada ?? 'sem margem'}. Estimativa com margem inicial constante e vendas orgânicas + ADS da campanha. Comparação observacional, sem prova de causalidade.${confundida ? ' Há eventos externos ou ajustes sobrepostos.' : ''}` };
}
module.exports = { GRUPOS, configurar, classificar, passo, experimento, medir };
