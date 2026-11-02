// Commission rules are the actual rules used by the Projection screen.
// Fonte por cliente: a base automática (glr_sync_estado resumo/pedidos) das contas comissão
// que cobrem o mês — a mesma do Dashboard, Gestores e Rentabilidade; a Projeção salva
// (glr_projecoes) só entra para cliente sem nenhuma conta na base. Sem nenhuma das duas, o
// cliente fica em "faltantes" (desconhecido, nunca zero).
// Projeção do mês = realizado até ontem + ritmo dos últimos 7 dias × dias que faltam (sem o
// ritmo de 7 dias na base, o ritmo do próprio mês). Firme desde o dia 2: não multiplica 1 dia por 30.
const {comissao}=require('../js/data');
const n=v=>parseFloat(v)||0;
const mkt=v=>{v=String(v||'').toLowerCase().replace(/\s/g,'');return /meli|mercado|^ml$/.test(v)?'ml':/tiktok/.test(v)?'tiktok':v};
const contaDe=ct=>String(ct?.param_to_use?.shopId||ct?.param_to_use?.meliUserId||ct?.param_to_use?.amazon_account_id||ct?.param_to_use?.magalu_account_id||ct?.param_to_use?.shein_supplier_id||ct?.external_id||'');
const hojeBRT=()=>new Date(Date.now()-3*3600e3).toISOString().slice(0,10);
const maisDias=(iso,d)=>{const x=new Date(iso+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+d);return x.toISOString().slice(0,10)};
const inicioDia=iso=>Date.parse(iso+'T00:00:00-03:00')/1000;
function receitaProjecao({clientes=[],projecoes=[],vinculos={},excecoes={},base=[]},mes,hoje=hojeBRT()){
 const mapa=new Map(base.map(r=>[`${mkt(r.marketplace)}:${r.conta_id}:${r.recurso}`,r]));
 // a loja tem na base todos os pedidos desde `iso`?
 const cobre=(k,iso)=>{const resumo=mapa.get(k+':resumo'),ped=mapa.get(k+':pedidos');return resumo?.ultimo_sucesso&&ped?.cursor?.historico_ate&&ped.cursor.historico_ate<=inicioDia(iso)?resumo:null};
 const diasNoMes=new Date(Date.UTC(+mes.slice(0,4),+mes.slice(5,7),0)).getUTCDate();
 const ontem=maisDias(hoje,-1),fimMes=`${mes}-${String(diasNoMes).padStart(2,'0')}`;
 // data-base pela base: ontem no mês corrente (dia 1 ainda não tem dia fechado), o último dia num mês passado
 const dataBaseAuto=ontem<mes+'-01'?null:ontem>fimMes?fimMes:ontem;
 const detalhes=[],faltantes=[];
 const somar=(dias,de,ate)=>{let fat=0,vendas=0;for(const[d,v]of Object.entries(dias||{}))if(d>=de&&d<=ate){fat+=n(v.faturamento);vendas+=n(v.unidades||v.pedidos);}return{fat,vendas}};
 for(const c of clientes){
  const vinculadas=vinculos[String(c.id)]||[];
  const gera=ct=>![ct?.external_id,ct?.param_to_use?.shopId,ct?.param_to_use?.meliUserId,ct?.param_to_use?.magalu_account_id,ct?.id].some(id=>id!=null&&excecoes[String(id)]===false);
  // 1) base automática das contas comissão
  if(dataBaseAuto){
   const dd=+dataBaseAuto.slice(8,10),faltam=diasNoMes-dd,ini7=maisDias(dataBaseAuto,-6);
   let fat=0,vendas=0,ritmoFat=0,ritmoVendas=0,cobertas=0;
   for(const ct of vinculadas.filter(gera)){
    const k=`${mkt(ct.marketplace)}:${contaDe(ct)}`,resumo=cobre(k,mes+'-01');if(!resumo)continue;cobertas++;
    const m=somar(resumo.cursor?.dias,mes+'-01',dataBaseAuto);fat+=m.fat;vendas+=m.vendas;
    if(faltam>0){const s7=cobre(k,ini7)?somar(resumo.cursor?.dias,ini7,dataBaseAuto):null;ritmoFat+=s7?s7.fat/7:m.fat/dd;ritmoVendas+=s7?s7.vendas/7:m.vendas/dd;}
   }
   if(cobertas){
    const fatP=fat+ritmoFat*faltam,vendasP=vendas+ritmoVendas*faltam;
    detalhes.push({clienteId:String(c.id),cliente:c.nome,fonte:'base',dataBase:dataBaseAuto,dias:dd,receitaBase:comissao.estimar(c,vendas,fat),receitaProjetada:comissao.estimar(c,vendasP,fatP),gmvBase:Math.round(fat),gmvProjetado:Math.round(fatP)});
    continue;
   }
  }
  // 2) sem conta na base: a Projeção salva do mês
  const p=projecoes.find(p=>String(p.chave)===String(c.id));
  if(p?.dataBase?.startsWith(mes+'-')&&n(p.diasDecorridos)>0&&n(p.diasNoMes)>0){
   const dd=n(p.diasDecorridos),dm=n(p.diasNoMes);
   const elegivel=l=>l.contaId?excecoes[String(l.contaId)]!==false:(()=>{const contas=vinculadas.filter(ct=>mkt(ct.marketplace)===mkt(l.marketplace||l._platNome||l.nome));return !contas.length||contas.some(gera)})();
   let fat=0,vendas=0;const vistas=new Set();
   for(const l of p.plataformas||[]){
    if(!elegivel(l))continue;
    if(l.contaId){if(!vinculadas.some(ct=>String(ct.external_id)===String(l.contaId))||vistas.has(String(l.contaId)))continue;vistas.add(String(l.contaId));}
    const resumo=cobre(`${mkt(l.marketplace||l._platNome)}:${l.contaId}`,mes+'-01');
    if(resumo){const m=somar(resumo.cursor?.dias,mes+'-01',p.dataBase);fat+=m.fat;vendas+=m.vendas;}
    else{fat+=n(l.fatBase);vendas+=n(l.vendasBase);}
   }
   detalhes.push({clienteId:String(c.id),cliente:c.nome,fonte:'projecao',dataBase:p.dataBase,dias:dd,receitaBase:comissao.estimar(c,vendas,fat),receitaProjetada:comissao.estimar(c,vendas/dd*dm,fat/dd*dm),gmvBase:Math.round(fat),gmvProjetado:Math.round(fat/dd*dm)});
   continue;
  }
  faltantes.push(c.nome);
 }
 const soma=k=>detalhes.length?detalhes.reduce((s,d)=>s+d[k],0):null;
 const dias=detalhes.length?Math.min(...detalhes.map(d=>d.dias)):null;
 return {fonte:'Base automática (realizado + ritmo de 7 dias) · comissão GLR',mes,base:soma('receitaBase'),projetada:soma('receitaProjetada'),gmvBase:soma('gmvBase'),gmvProjetado:soma('gmvProjetado'),dias,instavel:dias!=null&&dias<3,parcial:faltantes.length>0,faltantes,detalhes};
}
module.exports={receitaProjecao};
