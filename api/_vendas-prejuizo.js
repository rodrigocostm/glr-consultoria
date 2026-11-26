// Apuração por pedido usando a base sincronizada. Nunca consulta o MCP.
const {listar,config}=require('./_push-db');
const n=v=>{if(v==null||v==='')return null;const x=Number(v);return Number.isFinite(x)?x:null;};
const r=v=>Math.round((v+Number.EPSILON)*100)/100;
function calcularPedido(p,ctx={}){
 if(p.situacao!=='valido'||/^(UNPAID|PENDING|AWAITING_PAYMENT|CANCEL.*|INVALID|INCOMPLETE|ON_HOLD)$/i.test(p.status_original||''))return null;
 const itens=Array.isArray(p.itens)?p.itens:[],cat=ctx.catalogo||{},manual=ctx.custos?.[p.pedido_id]||{};
 const receita=n(p.valor_bruto);if(!(receita>0))return null;
 const produto=itens.map(i=>i.nome||i.item_id||'Produto').join(' + ')||String(p.pedido_id);
 const qtd=itens.reduce((s,i)=>s+(n(i.qtd)>0?n(i.qtd):1),0)||1;
 const custoManual=n(manual.custo),unit=i=>{
  const ks=p.marketplace==='ml'?[i.item_id,i.nome]:[i.nome,i.item_id];
  for(const k of ks){if(k!=null&&n(cat[k])>0)return n(cat[k]);}return null;
 };
 let custo=null;
 if(custoManual>0)custo=custoManual*qtd;
 else if(itens.length&&itens.every(i=>unit(i)!=null))custo=itens.reduce((s,i)=>s+unit(i)*(n(i.qtd)>0?n(i.qtd):1),0);
 // Chave legada de conjunto usada pela página Vendas.
 else {const key=itens.length>1?`${itens[0].nome} (+${itens.length-1})`:null;if(key&&n(cat[key])>0)custo=n(cat[key])*qtd;}
 const tx=p.taxas||{},liquido=n(p.liquido),recarga=n(tx.detalhes?.ads_escrow_top_up_fee_or_technical_support_fee)||0;
 const frete=p.marketplace==='ml'?(n(p.frete)||0):0;
 // Imposto já retido no repasse não é deduzido uma segunda vez.
 const impostoRetido=(n(tx.imposto)||0)>0;
 const aliquota=n(manual.imposto)||n(ctx.aliquotas?.[p.conta_id])||0;
 const imposto=impostoRetido?0:receita*aliquota/100;
 const outros=n(manual.outros)||0;
 const extras=(Array.isArray(ctx.linhas)?ctx.linhas:[]).reduce((s,l)=>s+(l.tipo==='pct'?receita*(n(l.valor)||0)/100:(n(l.valor)||0)),0);
 const resultado=custo==null||liquido==null?null:r(liquido+recarga-frete-custo-imposto-outros-extras);
 const status=custo==null?'sem_custo':liquido==null?'taxas_pendentes':resultado<0?'prejuizo':'sem_prejuizo';
 return {marketplace:p.marketplace,conta_id:String(p.conta_id),pedido_id:String(p.pedido_id),criado_em:p.criado_em,produto,itens:itens.map(i=>({id:String(i.item_id||i.nome||''),nome:i.nome||i.item_id,qtd:n(i.qtd)||1})),qtd,receita:r(receita),liquido,custo:custo==null?null:r(custo),frete:r(frete),recarga:r(recarga),imposto:r(imposto),impostoRetido,outros:r(outros),extras:r(extras),resultado,margem:resultado==null?null:r(resultado/receita*100),estimado:!!tx.estimado,status};
}
function agrupar(rows){
 const grupos=new Map();
 for(const p of rows.filter(p=>p.status==='prejuizo')){
  // Pedidos de vários itens são apresentados como conjunto: não atribui a perda a um SKU sem rateio.
  const produtoKey=JSON.stringify(p.itens.map(i=>i.id).sort());
  const key=require('node:crypto').createHash('sha256').update(JSON.stringify([p.marketplace,p.conta_id,produtoKey==='[]'?p.pedido_id:produtoKey])).digest('hex').slice(0,32);
  const g=grupos.get(key)||{chave:key,marketplace:p.marketplace,conta_id:p.conta_id,produto:p.produto,pedidos:0,perda:0,estimado:false,ultimo:p.criado_em};
  g.pedidos++;g.perda=r(g.perda-p.resultado);g.estimado=g.estimado||p.estimado;if(p.criado_em>g.ultimo)g.ultimo=p.criado_em;grupos.set(key,g);
 }return [...grupos.values()].sort((a,b)=>b.perda-a.perda);
}
async function carregar({inicio,fim,conta,gestor,cliente,cache,versaoBase}={}){
 const hoje=new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
 inicio=inicio||new Date(Date.parse(hoje+'T12:00:00-03:00')-29*864e5).toISOString().slice(0,10);fim=fim||hoje;
 const [catalogo,custos,aliquotas,linhas,clientes,gestores,vinc]=await Promise.all(['glr_vendas_custo_catalogo','glr_vendas_custos','glr_aliquotas','glr_vendas_linhas','glr_clientes','glr_gestores','glr_mc_vinculos'].map(config));
 const assinatura=require('node:crypto').createHash('sha256').update(JSON.stringify([inicio,fim,catalogo,custos,aliquotas,linhas,clientes,gestores,vinc,versaoBase])).digest('hex');
 if(cache?.assinatura===assinatura&&Date.now()-cache.em<15*60000)return {grupos:cache.grupos,cache};
 const {carteira}=require('./_push-audience');const contas=carteira(vinc,clientes),listaContas=[];
 for(const [key,c]of contas){const cli=(clientes||[]).find(x=>carteira({[x.id]:vinc?.[x.id]||[]},[x]).has(key));const g=(gestores||[]).find(g=>String(g.id)===String(cli?.gestorId)||g.nome===cli?.gestor);listaContas.push({key,marketplace:c.mkt,conta_id:c.id,nome:c.nome,cliente:cli?.nome||'',cliente_id:String(cli?.id||''),gestor_id:g?String(g.id):'sem',gestor:g?.nome||'Sem gestor'});}
 const selecionadas=listaContas.filter(c=>(!conta||c.key===conta)&&(!gestor||c.gestor_id===gestor)&&(!cliente||c.cliente_id===String(cliente)));
 const selecionados=new Set(selecionadas.map(c=>c.key));
 const filtro=conta?`&marketplace=eq.${encodeURIComponent(conta.split(':')[0])}&conta_id=eq.${encodeURIComponent(conta.slice(conta.indexOf(':')+1))}`:'';
 const pedidos=selecionadas.length?await listar('glr_pedidos?situacao=eq.valido&criado_em=gte.'+encodeURIComponent(inicio+'T00:00:00-03:00')+'&criado_em=lte.'+encodeURIComponent(fim+'T23:59:59.999-03:00')+filtro+'&select=marketplace,conta_id,pedido_id,criado_em,status_original,situacao,valor_bruto,liquido,frete,taxas,itens&order=criado_em.desc,marketplace,conta_id,pedido_id',150000):[];
 const rows=pedidos.filter(p=>selecionados.has(`${p.marketplace}:${p.conta_id}`)).map(p=>calcularPedido(p,{catalogo,custos,aliquotas,linhas})).filter(Boolean);
 const porConta=new Map(listaContas.map(c=>[c.key,c]));
 for(const p of rows)Object.assign(p,{conta:porConta.get(`${p.marketplace}:${p.conta_id}`)?.nome,gestor:porConta.get(`${p.marketplace}:${p.conta_id}`)?.gestor});
 return {inicio,fim,em:new Date().toISOString(),contas:listaContas,gestores:gestores||[],rows,grupos:agrupar(rows),cache:{assinatura,em:Date.now(),grupos:agrupar(rows)},resumo:{pedidos:rows.length,prejuizo:rows.filter(p=>p.status==='prejuizo').length,sem_custo:rows.filter(p=>p.status==='sem_custo').length,taxas_pendentes:rows.filter(p=>p.status==='taxas_pendentes').length,perda:r(rows.filter(p=>p.status==='prejuizo').reduce((s,p)=>s-p.resultado,0))}};
}
module.exports={calcularPedido,agrupar,carregar};
