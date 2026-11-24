const { test } = require('node:test');
const assert = require('node:assert/strict');
const motor = require('../api/_ml-crescimento');
const { aplicarAcaoML, processarContaML } = require('../api/_agente-ml');
const config = (extra={}) => motor.configurar({piloto:true,teto_tacos:8,meta_faturamento:100000,margem_reserva:10,passo_max:15,...extra},{meta_acos:20});
const familia = {vendasAj:2000,gasto:200,cliques:250,unidades:15};
const aviso = {aa:35,ne:'ok',dias:40,estoque:100};
const ctx = () => motor.classificar(familia,aviso,config());
const mensal = {tacos:5,cobertura:true,projecao:80000};
const proposta = {acao:'orcamento',de:100,para:150,impacto:1000,impacto_tipo:'ganho'};
test('ACOS e TACOS independentes: nenhuma inferência de teto de TACOS pelo ACOS',()=>{
  const c=motor.configurar({}, {meta_acos:20});assert.equal(c.teto_tacos,null);assert.equal(c.meta_acos,20);
  assert.equal(motor.classificar(familia,aviso,c).grupo,'desenvolver');
});
test('percentuais inválidos e valores não finitos são descartados',()=>{
  const c=motor.configurar({teto_tacos:Infinity,limites_grupo:{escalar:150},margem_reserva:-1},{meta_acos:120});
  assert.equal(c.meta_acos,null);assert.equal(c.teto_tacos,null);assert.equal(c.limites_grupo.escalar,null);assert.equal(c.margem_reserva,null);
});
test('quatro grupos: escala, oferta travada, amostra baixa e contenção',()=>{
  assert.equal(ctx().grupo,'escalar');
  assert.equal(motor.classificar({...familia,semBuybox:true},aviso,config()).grupo,'destravar');
  assert.equal(motor.classificar({...familia,cliques:4,unidades:1},aviso,config()).grupo,'desenvolver');
  assert.equal(motor.classificar({...familia,gasto:600},aviso,config()).grupo,'conter');
  assert.equal(motor.classificar(familia,{...aviso,ne:'zerado'},config()).grupo,'conter');
});
test('estoque e teto ausentes impedem escala; custo e reserva ausentes só reduzem a confiança',()=>{
  for(const av of [null,{aa:35}]) assert.notEqual(motor.classificar(familia,av,config()).grupo,'escalar');
  assert.notEqual(motor.classificar(familia,aviso,config({teto_tacos:null})).grupo,'escalar');
  for(const [av,c] of [[{ne:'ok'},config()],[aviso,config({margem_reserva:null})]]) {
    const r=motor.classificar(familia,av,c); assert.equal(r.grupo,'escalar'); assert.equal(r.confianca,'media'); assert.ok(r.avisos.length);
  }
});
test('reserva de margem e teto do grupo limitam ACOS do produto',()=>{
 assert.equal(motor.classificar(familia,{...aviso,aa:25},config()).limite_acos,15);
 assert.equal(motor.classificar(familia,aviso,config({limites_grupo:{escalar:8}})).grupo,'conter');
});
test('sem cobertura ou com TACOS no teto nenhuma proposta de escala; meta de faturamento não é obrigatória',()=>{
 for(const m of [{...mensal,tacos:null},{...mensal,cobertura:false},{...mensal,tacos:8}]) assert.equal(motor.experimento(proposta,ctx(),config(),m).bloqueado,true);
 assert.notEqual(motor.experimento(proposta,ctx(),config({meta_faturamento:null}),mensal).bloqueado,true);
});
test('passos adaptativos respeitam confiança, teto configurado e proposta original',()=>{
 assert.equal(motor.experimento(proposta,ctx(),config(),mensal).dados.para,115);
 assert.equal(motor.experimento(proposta,{...ctx(),confianca:'media'},config(),mensal).dados.para,110);
 assert.equal(motor.experimento({...proposta,para:104},ctx(),config(),mensal).dados.para,104);
 assert.equal(motor.experimento(proposta,ctx(),config({passo_max:5}),mensal).dados.para,105);
});
test('redução do ROAS nunca cruza o limite econômico do ACOS',()=>{
 const d=motor.experimento({...proposta,acao:'roas_target',de:6,para:3},ctx(),config(),mensal).dados;
 assert.equal(d.para,5.1);assert.ok(100/d.para<=d.experimento.meta_acos);
 assert.equal(motor.experimento({...proposta,acao:'roas_target',de:5,para:3},ctx(),config(),mensal).bloqueado,true);
});
test('prioridade usa contribuição, confiança e distância da meta sem romper limites',()=>{
 const a=motor.experimento(proposta,ctx(),config(),mensal).dados;
 const b=motor.experimento(proposta,{...ctx(),confianca:'media'},config(),mensal).dados;
 assert.ok(a.prioridade>b.prioridade);assert.equal(a.crescimento.contribuicao_hipotese,45);assert.equal(a.experimento.medir_apos_dias,21);assert.equal(a.experimento.requer_aprovacao,true);
});
test('piloto não executa campanhas mesmo com autonomia liberada',async()=>{
 let chamadas=0;const d=motor.experimento({...proposta,campaign_id:1},ctx(),config(),mensal).dados;
 const r=await aplicarAcaoML(d,{cfg:{},contaId:'1',mcpCall:async()=>{chamadas++;},mcApiKey:'mock'});
 assert.equal(r.ok,false);assert.equal(chamadas,0);
});
test('medição exige faturamento e contribuição preservados dentro do TACOS',()=>{
 const exp={margem_antes_ads:35,teto_tacos:8};
 assert.equal(motor.medir({total:1000,ads:60},{total:1200,ads:80},exp).veredito,'melhorou');
 assert.equal(motor.medir({total:1000,ads:60},{total:1200,ads:200},exp).veredito,'piorou');
 assert.equal(motor.medir({total:1000,ads:60},{total:800,ads:50},exp).veredito,'piorou');
});
test('eventos externos, sobreposição e dados ausentes não viram resultado favorável',()=>{
 const exp={margem_antes_ads:35,teto_tacos:8},a={total:1000,ads:60},b={total:1200,ads:80};
 for(const x of [motor.medir(a,b,exp,['promoção']),motor.medir(a,b,exp,[],true),motor.medir(null,b,exp),motor.medir({total:NaN,ads:60},b,exp),motor.medir({total:0,ads:0},b,exp),motor.medir(a,b,{teto_tacos:8})]) assert.equal(x.veredito,'inconclusivo');
});
test('análise lê plano isolado por conta, publica mapa e não escreve no ML',async()=>{
 const writes=[],calls=[],reads=[];
 const date='2026-11-16';
 const h={sbSelect:async(t,q)=>{reads.push([t,q]);return t==='glr_storage'?[{dados:config()}]:[];},sbInsert:async(t,r)=>writes.push([t,r]),sbUpdate:async()=>{},sbUpsert:async(t,r)=>writes.push([t,r]),lerBase:async()=>({}),baseCobre:()=>true,baseCobreAds:()=>true,somarBase:()=>({faturamento:10000,ads:500,pedidos:20,valor_cancelado:0,valor_devolvido:0}),isoMenos:(d,n)=>new Date(Date.parse(d+'T12:00:00Z')-n*864e5).toISOString().slice(0,10),dataBRT:()=>({iso:date}),R$:n=>'R$ '+n,mcpCall:async(k,act)=>{calls.push(act);return {results:[]};}};
 const r=await processarContaML({conta_id:'conta-A',meta_acos:20},'mock',h);
 assert.equal(r.erro,undefined);assert.ok(reads.some(([t,q])=>t==='glr_storage'&&q.includes('glr_ml_crescimento_conta-A')));
 const snapshot=writes.find(([t,r])=>t==='glr_sync_estado'&&r.recurso==='crescimento')[1];
 assert.equal(snapshot.conta_id,'conta-A');assert.equal(snapshot.cursor.config.teto_tacos,8);assert.equal(snapshot.cursor.mensal.projecao,18750);
 assert.equal(calls.some(a=>a.startsWith('ml_ads_update')),false);
});
test('campanha elegível gera orçamento limitado em sugestão; teste aberto impede outro ajuste',async()=>{
 for(const aberto of [false,true]) {
  const rows=[],updates=[];
  const date='2026-11-16',plan=config();
  const campaign={id:7,name:'Campanha piloto',status:'active',date_created:'2026-01-01',budget:100,roas_target:8,metrics:{cost:500,total_amount:5000,units_quantity:20}};
  const item={item_id:'MLB1',campaign_id:7,status:'active',title:'Produto',price:250,metrics:{cost:500,total_amount:5000,units_quantity:20,clicks:250}};
  const log=aberto?[{id:'anterior',resultado:'executado',criado_em:'2026-11-14T15:00:00Z',dados:{campaign_id:7,acao:'orcamento',aplicado_em:'2026-11-14T15:00:00Z',experimento:{medir_apos_dias:21}}}]:[];
  const h={sbSelect:async(t)=>t==='glr_storage'?[{dados:plan}]:t==='glr_agente_log'?log:[],sbInsert:async(t,r)=>rows.push(r),sbUpdate:async()=>{},sbUpsert:async()=>{},lerBase:async()=>({}),lerSinais:async()=>({itens:{MLB1:{aa:35,m:25,e:100,d:40,ne:'ok'}}}),baseCobre:()=>true,baseCobreAds:()=>true,somarBase:()=>({faturamento:10000,ads:500,pedidos:20,valor_cancelado:0,valor_devolvido:0}),isoMenos:(d,n)=>new Date(Date.parse(d+'T12:00:00Z')-n*864e5).toISOString().slice(0,10),dataBRT:()=>({iso:date}),R$:n=>'R$ '+n,mcpCall:async(k,act,p)=>{if(act.includes('update')) updates.push(act);if(act==='ml_ads_campaigns')return {results:[campaign]};if(act==='ml_ads_items')return {results:[item]};return {metrics:{impression_share:.3,lost_impression_share_by_budget:.4,lost_impression_share_by_ad_rank:.3,cost:500,total_amount:5000,organic_units_amount:5000}};}};
  const r=await processarContaML({conta_id:'teste',meta_acos:20,regra_pausa_dias:7},'mock',h);
  assert.equal(r.erro,undefined);assert.equal(updates.length,0);
  const testes=rows.filter(r=>r.dados.experimento);
  if(aberto) assert.equal(testes.length,0);
  else {assert.equal(testes.length,1);assert.equal(testes[0].resultado,'so_alerta');assert.equal(testes[0].dados.para,115);}
 }
});
test('arredondamento não cruza piso de ROAS e medição respeita reserva após ADS',()=>{
 const c={...ctx(),limite_acos:17};
 const d=motor.experimento({...proposta,acao:'roas_target',de:6,para:3},c,config(),mensal).dados;
 assert.equal(d.para,5.89);assert.ok(100/d.para<=17);
 const r=motor.medir({total:1000,ads:70},{total:1100,ads:80},{margem_antes_ads:15,teto_tacos:8,margem_reserva:10});assert.equal(r.veredito,'piorou');
});
