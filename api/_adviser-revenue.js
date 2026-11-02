// Commission rules are the actual rules used by the Projection screen.
// Fonte por cliente: a Projeção salva do mês (glr_projecoes) quando existe; senão a base
// automática (glr_sync_estado resumo/pedidos) das contas comissão que cobrem o mês — a mesma
// das telas Gestores e Rentabilidade. Sem nenhuma das duas, o cliente fica em "faltantes".
const {comissao}=require('../js/data');
const n=v=>parseFloat(v)||0;
const mkt=v=>{v=String(v||'').toLowerCase().replace(/\s/g,'');return /meli|mercado|^ml$/.test(v)?'ml':/tiktok/.test(v)?'tiktok':v};
const contaDe=ct=>String(ct?.param_to_use?.shopId||ct?.param_to_use?.meliUserId||ct?.param_to_use?.amazon_account_id||ct?.param_to_use?.magalu_account_id||ct?.param_to_use?.shein_supplier_id||ct?.external_id||'');
const hojeBRT=()=>new Date(Date.now()-3*3600e3).toISOString().slice(0,10);
const maisDias=(iso,d)=>{const x=new Date(iso+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+d);return x.toISOString().slice(0,10)};
function receitaProjecao({clientes=[],projecoes=[],vinculos={},excecoes={},base=[]},mes,hoje=hojeBRT()){
 const mapa=new Map(base.map(r=>[`${mkt(r.marketplace)}:${r.conta_id}:${r.recurso}`,r]));
 const inicio=Date.parse(mes+'-01T00:00:00-03:00')/1000;
 const cobre=k=>{const resumo=mapa.get(k+':resumo'),ped=mapa.get(k+':pedidos');return resumo?.ultimo_sucesso&&ped?.cursor?.historico_ate&&ped.cursor.historico_ate<=inicio?resumo:null};
 const diasNoMes=new Date(Date.UTC(+mes.slice(0,4),+mes.slice(5,7),0)).getUTCDate();
 const ontem=maisDias(hoje,-1),fimMes=`${mes}-${String(diasNoMes).padStart(2,'0')}`;
 // data-base pela base: ontem no mês corrente (dia 1 ainda não tem dia fechado), o último dia num mês passado
 const dataBaseAuto=ontem<mes+'-01'?null:ontem>fimMes?fimMes:ontem;
 const detalhes=[],faltantes=[];
 for(const c of clientes){
  const vinculadas=vinculos[String(c.id)]||[];
  const gera=ct=>![ct?.external_id,ct?.param_to_use?.shopId,ct?.param_to_use?.meliUserId,ct?.param_to_use?.magalu_account_id,ct?.id].some(id=>id!=null&&excecoes[String(id)]===false);
  const p=projecoes.find(p=>String(p.chave)===String(c.id));
  if(p?.dataBase?.startsWith(mes+'-')&&n(p.diasDecorridos)>0&&n(p.diasNoMes)>0){
   const dd=n(p.diasDecorridos),dm=n(p.diasNoMes);
   const elegivel=l=>l.contaId?excecoes[String(l.contaId)]!==false:(()=>{const contas=vinculadas.filter(ct=>mkt(ct.marketplace)===mkt(l.marketplace||l._platNome||l.nome));return !contas.length||contas.some(gera)})();
   let fat=0,vendas=0;const vistas=new Set();
   for(const l of p.plataformas||[]){
    if(!elegivel(l))continue;
    if(l.contaId){if(!vinculadas.some(ct=>String(ct.external_id)===String(l.contaId))||vistas.has(String(l.contaId)))continue;vistas.add(String(l.contaId));}
    const resumo=cobre(`${mkt(l.marketplace||l._platNome)}:${l.contaId}`);
    if(resumo){for(const[d,v]of Object.entries(resumo.cursor?.dias||{}))if(d>=mes+'-01'&&d<=p.dataBase){fat+=n(v.faturamento);vendas+=n(v.unidades||v.pedidos);}}
    else{fat+=n(l.fatBase);vendas+=n(l.vendasBase);}
   }
   detalhes.push({clienteId:String(c.id),cliente:c.nome,fonte:'projecao',dataBase:p.dataBase,dias:dd,receitaBase:comissao.estimar(c,vendas,fat),receitaProjetada:comissao.estimar(c,vendas/dd*dm,fat/dd*dm),gmvProjetado:Math.round(fat/dd*dm)});
   continue;
  }
  // sem Projeção salva no mês: base automática das contas comissão
  let fat=0,vendas=0,cobertas=0;
  if(dataBaseAuto)for(const ct of vinculadas.filter(gera)){
   const resumo=cobre(`${mkt(ct.marketplace)}:${contaDe(ct)}`);if(!resumo)continue;cobertas++;
   for(const[d,v]of Object.entries(resumo.cursor?.dias||{}))if(d>=mes+'-01'&&d<=dataBaseAuto){fat+=n(v.faturamento);vendas+=n(v.unidades||v.pedidos);}
  }
  if(!cobertas){faltantes.push(c.nome);continue;}
  const dd=+dataBaseAuto.slice(8,10);
  detalhes.push({clienteId:String(c.id),cliente:c.nome,fonte:'base',dataBase:dataBaseAuto,dias:dd,receitaBase:comissao.estimar(c,vendas,fat),receitaProjetada:comissao.estimar(c,vendas/dd*diasNoMes,fat/dd*diasNoMes),gmvProjetado:Math.round(fat/dd*diasNoMes)});
 }
 const soma=k=>detalhes.length?detalhes.reduce((s,d)=>s+(k==='base'?d.receitaBase:d.receitaProjetada),0):null;
 const dias=detalhes.length?Math.min(...detalhes.map(d=>d.dias)):null;
 // com poucos dias fechados a projeção do mês oscila muito: a tela avisa
 return {fonte:'Base automática e Projeção de faturamento · comissão GLR',mes,base:soma('base'),projetada:soma('projetada'),dias,instavel:dias!=null&&dias<5,parcial:faltantes.length>0,faltantes,detalhes};
}
module.exports={receitaProjecao};
