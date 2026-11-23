// Fonte única: pedidos pagos sincronizados e alertas já calculados pelos agentes.
// Não consulta marketplaces nem estima lucro. Resumos por dispositivo e categoria.
const {db,listar,config,vapid,usuarioPerfil}=require('./_push-db');
const core=require('./_push-core');const audience=require('./_push-audience');
module.exports=async(req,res)=>{
 if(!require('./_auth').cronAuthorized(req))return res.status(401).json({error:'unauthorized'});
 try{
  const webpush=vapid();
  const agora=new Date(),desde=new Date(agora-48*3600e3).toISOString();
  const [subs,staff,pedidos,logs,ads]=await Promise.all([
   db('push_subscriptions?select=*'),db('glr_staff?ativo=eq.true&select=user_id'),
   listar('glr_pedidos?situacao=eq.valido&criado_em=gte.'+desde+'&select=marketplace,conta_id,pedido_id,criado_em,status_original,situacao,valor_bruto&order=criado_em.desc,marketplace,conta_id,pedido_id'),
   listar('glr_agente_log?tipo=eq.alerta&resultado=eq.so_alerta&criado_em=gte.'+desde+'&select=id,conta_id,titulo,explicacao,dados,criado_em&order=criado_em.desc,id'),listar('glr_ads_diario?data=gte.'+new Date(agora-9*86400e3).toISOString().slice(0,10)+'&select=marketplace,conta_id,data,gasto&order=data,marketplace,conta_id')]);
  const ativos=new Set(staff.map(s=>String(s.user_id)));
  const eventos=[...pedidos.filter(core.vendaValida).map(core.eventoPedido),...logs.map(core.eventoAgente)];
  // Situação diária da meta por cliente, somente contas com resumos atualizados.
  const dia=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(agora);
  const [metas,vinc,clientes,resumos,historicos,portais]=await Promise.all([config('glr_metas'),config('glr_mc_vinculos'),config('glr_clientes'),db('glr_sync_estado?recurso=eq.resumo&select=conta_id,marketplace,cursor,ultimo_sucesso'),db('glr_sync_estado?recurso=eq.pedidos&select=conta_id,marketplace,cursor'),config('glr_portal_configs')]);
  const nomes={};for(const c of clientes||[])nomes[c.id]=c.nome;
  for(const [cli,meta] of Object.entries(metas||{})){
   if(!(meta>0))continue;
   const contas=[...new Set((vinc?.[cli]||[]).map(c=>String(c.external_id)))];
   const base=resumos.filter(r=>contas.includes(String(r.conta_id)));
   if(!contas.length||contas.some(id=>!base.some(r=>String(r.conta_id)===id&&Date.parse(r.ultimo_sucesso)>agora-24*3600e3 && historicos.some(h=>h.marketplace===r.marketplace && String(h.conta_id)===String(r.conta_id) && h.cursor?.historico_ate && h.cursor.historico_ate<=Date.parse(dia.slice(0,8)+'01T00:00:00-03:00')/1000))))continue;
   let faturamento=0;for(const r of base)for(const [d,v]of Object.entries(r.cursor?.dias||{}))if(d>=dia.slice(0,8)+'01'&&d<dia)faturamento+=+v.faturamento||0;
   const dias=+dia.slice(8)-1,mesDias=new Date(+dia.slice(0,4),+dia.slice(5,7),0).getDate();if(dias<1)continue;
   const proj=faturamento/dias*mesDias;
   eventos.push({chave:'meta:'+cli+':'+dia,categoria:'metas',contas,em:agora.toISOString(),titulo:nomes[cli]||'Cliente',texto:`Projeção ${core.dinheiro(proj)} · meta ${core.dinheiro(meta)} (${Math.round(proj/meta*100)}%). Até ontem, sem garantia de fechamento.`});
  }
  let enviados=0,falhas=0;const autorizados=new Map();
  for(const s of subs){
   if(!autorizados.has(s.user_id))autorizados.set(s.user_id,await usuarioPerfil(s.user_id,Array.isArray(portais)?portais:[],ativos));
   const perfil=autorizados.get(s.user_id);if(!perfil)continue;
   const p=audience.preferencias(s.preferencias,perfil.tipo);if(core.silencioso(p,agora))continue;
   const contas=audience.carteira(vinc,clientes,p.contas);
   const coberto=[...contas.values()].every(c=>historicos.some(h=>h.marketplace===c.mkt&&String(h.conta_id)===c.id&&h.cursor?.historico_ate&&h.cursor.historico_ate<=Date.parse(dia+'T00:00:00-03:00')/1000-86400));
   const resumo=audience.resumoVendometro(pedidos,ads,contas,agora,coberto);
   const especificos=audience.oscilacoes(ads,contas,agora);
   const listaPerfil=perfil.tipo==='consultoria'?[...eventos.filter(e=>e.categoria==='saldo'),...especificos,...(resumo&&contas.size?[resumo]:[])]:[...eventos.filter(e=>['vendas','saldo'].includes(e.categoria)||(e.categoria==='metas'&&e.chave.startsWith('meta:')))];
   const candidatos=listaPerfil.filter(e=>Date.parse(e.em)>=Date.parse(s.criado_em)&&audience.autorizado(perfil,p,e));
   for(const categoria of ['vendas','saldo','metas','vendometro','oscilacao']){
    const grupo=candidatos.filter(e=>e.categoria===categoria);if(!grupo.length)continue;
    // Inserção atômica: apenas eventos ainda não enviados entram no resumo.
    const claims=await db('push_deliveries?on_conflict=endpoint,evento',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify(grupo.map(e=>({endpoint:s.endpoint,evento:e.chave})))});
    if(!claims?.length)continue;
    const novos=new Set(claims.map(c=>c.evento)),lista=grupo.filter(e=>novos.has(e.chave));
    const titulo={vendas:'Novas vendas',saldo:'Saldo de Ads',metas:'Metas dos clientes',agentes:'Alertas dos agentes',vendometro:'Resultado do Vendômetro',oscilacao:'Oscilação de gasto em Ads'}[categoria];
    const valor=lista.reduce((n,e)=>n+(e.valor||0),0);
    const texto=categoria==='vendas'?`${lista.length} pedido(s) pago(s) · ${core.dinheiro(valor)}\n${[...new Set(lista.map(e=>e.plataforma))].join(', ')}. Sem estimativa de lucro.`:lista.slice(0,2).map(e=>e.titulo+': '+e.texto).join('\n')+(lista.length>2?`\nMais ${lista.length-2} alertas no sistema.`:'');
    try{await webpush.sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},JSON.stringify({title:'GLR · '+titulo,body:texto,url:perfil.tipo==='portal'?'/index.html#portal':lista[0].url || '/index.html#'+(categoria==='vendas'?'vendas':'agente'),tag:'glr-'+categoria}),{TTL:3600});enviados++;}
    catch(e){falhas++;if([404,410].includes(e.statusCode)){await db('push_subscriptions?endpoint=eq.'+encodeURIComponent(s.endpoint),{method:'DELETE'});break;}else for(const c of claims)await db('push_deliveries?endpoint=eq.'+encodeURIComponent(s.endpoint)+'&evento=eq.'+encodeURIComponent(c.evento),{method:'DELETE'});}
   }
  }
  // Retenção limitada; eventos de vendas consultados têm no máximo 48 h.
  await db('push_deliveries?criado_em=lt.'+new Date(agora-7*86400e3).toISOString(),{method:'DELETE'});
  return res.json({ok:true,dispositivos:subs.length,enviados,falhas});
 }catch(e){console.error('[push-cron]',e.message);return res.status(503).json({error:'Não foi possível enviar notificações',detalhe:e.message});}
};

