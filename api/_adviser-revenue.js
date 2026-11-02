// Commission rules are the actual rules used by the Projection screen.
const {comissao}=require('../js/data');
const n=v=>parseFloat(v)||0;
const mkt=v=>{v=String(v||'').toLowerCase().replace(/\s/g,'');return /meli|mercado|^ml$/.test(v)?'ml':v};
function receitaProjecao({clientes=[],projecoes=[],vinculos={},excecoes={},base=[]},mes){
 const mapa=new Map(base.map(r=>[`${mkt(r.marketplace)}:${r.conta_id}:${r.recurso}`,r]));
 const detalhes=[],faltantes=[];
 for(const c of clientes){
  const p=projecoes.find(p=>String(p.chave)===String(c.id));
  if(!p?.dataBase?.startsWith(mes+'-')){faltantes.push(c.nome);continue;}
  const dd=n(p.diasDecorridos),dm=n(p.diasNoMes);
  if(dd<=0||dm<=0){faltantes.push(c.nome);continue;}
  const vinculadas=vinculos[String(c.id)]||[];
  const gera=ct=>![ct?.external_id,ct?.param_to_use?.shopId,ct?.param_to_use?.meliUserId,ct?.param_to_use?.magalu_account_id,ct?.id].some(id=>id!=null&&excecoes[String(id)]===false);
  const elegivel=l=>l.contaId?excecoes[String(l.contaId)]!==false:(()=>{const contas=vinculadas.filter(ct=>mkt(ct.marketplace)===mkt(l.marketplace||l._platNome||l.nome));return !contas.length||contas.some(gera)})();
  let fat=0,vendas=0;const vistas=new Set();
  for(const l of p.plataformas||[]){
   if(!elegivel(l))continue;
   if(l.contaId){if(!vinculadas.some(ct=>String(ct.external_id)===String(l.contaId))||vistas.has(String(l.contaId)))continue;vistas.add(String(l.contaId));}
   const k=`${mkt(l.marketplace||l._platNome)}:${l.contaId}`;
   const resumo=mapa.get(k+':resumo'),ped=mapa.get(k+':pedidos');
   const inicio=Date.parse(mes+'-01T00:00:00-03:00')/1000;
   if(resumo?.ultimo_sucesso&&ped?.cursor?.historico_ate&&ped.cursor.historico_ate<=inicio){
    for(const[d,v]of Object.entries(resumo.cursor?.dias||{}))if(d>=mes+'-01'&&d<=p.dataBase){fat+=n(v.faturamento);vendas+=n(v.unidades||v.pedidos);}
   }else{fat+=n(l.fatBase);vendas+=n(l.vendasBase);}
  }
  detalhes.push({clienteId:String(c.id),cliente:c.nome,dataBase:p.dataBase,receitaBase:comissao.estimar(c,vendas,fat),receitaProjetada:comissao.estimar(c,vendas/dd*dm,fat/dd*dm)});
 }
 return {fonte:'Projeção de faturamento · comissão GLR',mes,base:detalhes.length?detalhes.reduce((s,d)=>s+d.receitaBase,0):null,projetada:detalhes.length?detalhes.reduce((s,d)=>s+d.receitaProjetada,0):null,parcial:faltantes.length>0,faltantes,detalhes};
}
module.exports={receitaProjecao};
