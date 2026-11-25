// Account performance uses the same cached daily summaries as the dashboard.
const DAY=86400000;
const date=n=>new Date(n-3*3600000).toISOString().slice(0,10);
const shift=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*DAY).toISOString().slice(0,10);
const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const positive=v=>number(v)>0?number(v):null;
function sum(info,from,to){
 const start=Date.parse(from+'T00:00:00-03:00')/1000,end=Date.parse(to+'T23:59:59-03:00');
 const states=[info?.resumo,info?.pedidos,info?.ads];
 const covered=states.every(s=>s?.ultimo_sucesso&&!s.ultimo_erro&&Date.parse(s.ultimo_sucesso)>=end)&&number(info?.pedidos?.cursor?.historico_ate)!==null&&info.pedidos.cursor.historico_ate<=start&&number(info?.ads?.cursor?.hist_ate)!==null&&info.ads.cursor.hist_ate<=start;
 if(!covered||!info.resumo.cursor?.dias)return null;
 const total={faturamento:0,ads:0,pedidos:0};
 for(const [d,v] of Object.entries(info.resumo.cursor?.dias||{}))if(d>=from&&d<=to){
  for(const k of Object.keys(total)){const n=number(v[k]);if(n===null||n<0)return null;total[k]+=n;}
 }
 // Missing zero-sale days are legitimate only with complete sync coverage.
 return {...total,tacos:total.faturamento>0?100*total.ads/total.faturamento:null,de:from,ate:to};
}
function index(states){const out={};for(const s of states)(out[s.marketplace+':'+s.conta_id]??={})[s.recurso]=s;return out;}
function evaluate(action,actions,info,goal,now){
 if(action.status!=='executada')return {status:'sem_execucao',motivo:'Sugestão sem execução comprovada'};
 if(!action.executado_em||!Number.isFinite(Date.parse(action.executado_em)))return {status:'inconclusiva',motivo:'Data de execução não confirmada'};
 const day=date(Date.parse(action.executado_em)),end=shift(day,7);
 if(end>=date(now))return {status:'aguardando',motivo:'Aguardar sete dias completos após a execução'};
 const before=sum(info,shift(day,-7),shift(day,-1)),after=sum(info,shift(day,1),end);
 if(!before||!after)return {status:'inconclusiva',motivo:'Cobertura de faturamento ou Ads insuficiente',antes:before,depois:after};
 const overlap=actions.some(a=>a.id!==action.id&&a.conta===action.conta&&a.status==='executada'&&(!a.executado_em||date(Date.parse(a.executado_em))>=shift(day,-7)&&date(Date.parse(a.executado_em))<=end));
 const variation=before.faturamento>0?100*(after.faturamento/before.faturamento-1):null;
 return {status:overlap?'inconclusiva':'observada',motivo:overlap?'Outras ações na conta impedem isolar o efeito':'Variação observada; não comprova causalidade ou lucro',antes:before,depois:after,variacao_faturamento:variation,meta_tacos_atual:goal,dentro_meta_atual:goal!==null&&after.tacos!==null?after.tacos<=goal:null,lucro:null};
}
function build(ctx,actions,states,metas,metasTacos,configs,now=Date.now()){
 const by=index(states),today=date(now),yesterday=shift(today,-1),month=today.slice(0,8)+'01',elapsed=Number(today.slice(8))-1,days=new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7)),0)).getUTCDate();
 const get=a=>by[a.key]||{};
 const goal=a=>positive(metasTacos?.[a.cliente_id])??positive(configs.find(c=>String(c.conta_id)===(a.key||a.conta).slice((a.key||a.conta).indexOf(':')+1)&&(c.marketplace==='ml'?'mercado-livre':c.marketplace)===a.marketplace)?.meta_acos);
 const accounts=ctx.contas.map(a=>{const m=elapsed?sum(get(a),month,yesterday):null;return {...a,mes:m,projecao:m?m.faturamento/elapsed*days:null,meta_tacos_atual:goal(a),meta_faturamento_escopo:'cliente'};});
 const clients=(ctx.clientes||[]).map(c=>{const rows=accounts.filter(a=>a.cliente_id===String(c.id));const complete=rows.length>0&&rows.every(a=>a.mes);const revenue=complete?rows.reduce((n,a)=>n+a.mes.faturamento,0):null,ads=complete?rows.reduce((n,a)=>n+a.mes.ads,0):null;const target=positive(metas?.[c.id])??positive(c.metaMensal);return {cliente_id:String(c.id),gestor_id:String(c.gestorId||'sem'),faturamento:revenue,ads,tacos:revenue>0?ads/revenue*100:null,meta_faturamento_atual:target,meta_tacos_atual:positive(metasTacos?.[c.id]),projecao:revenue!==null&&elapsed?revenue/elapsed*days:null,completo:complete};});
 return {contas:accounts,clientes:clients,acoes:actions.map(a=>({...a,resultado_conta:evaluate(a,[...actions,...(ctx.intervencoes||[])],get({key:a.conta}),goal(a),now)})),metodo:'7 dias antes versus 7 depois; exclui o dia da execução. Faturamento válido e Ads total do resumo diário. Metas atuais não representam necessariamente a meta histórica. Projeção = média do mês até ontem × dias do mês.'};
}
async function cross(ctx,actions,{listar,config},now=Date.now()){
 try{const [states,metas,tacos,configs]=await Promise.all([listar('glr_sync_estado?recurso=in.(resumo,pedidos,ads)&select=marketplace,conta_id,recurso,cursor,ultimo_sucesso,ultimo_erro&order=marketplace,conta_id,recurso',10000),config('glr_metas'),config('glr_metas_tacos'),listar('glr_agente_config?select=conta_id,marketplace,meta_acos&order=conta_id,marketplace',10000)]);return {disponivel:true,...build(ctx,actions,states,metas,tacos,configs,now)};}
 catch(_){return {disponivel:false,aviso:'Cruzamento indisponível; tente atualizar. Histórico de ações preservado.'};}
}
module.exports={sum,evaluate,build,cross};
