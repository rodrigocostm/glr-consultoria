// Valores assinados do acerto TikTok; líquido é a fonte de verdade (não deduzir taxas outra vez).
function normalizarAcertoTikTok(resposta) {
  const d=resposta?.data || resposta || {};
  const tx=d.statement_transactions || [];
  if (!tx.length || tx.some(x=>x.settlement_amount == null || !Number.isFinite(+x.settlement_amount))) return null;
  const n=v=>Number.isFinite(+v)?+v:0;
  const r=v=>Math.round(v*100)/100;
  const soma=k=>tx.reduce((s,x)=>s+n(x[k]),0);
  const taxa=(x,k)=>x.fee_tax_breakdown?.fee?.[k] ?? x.fee_breakdown?.[k] ?? x[k];
  const somarTaxa=k=>tx.reduce((s,x)=>s+n(taxa(x,k)),0);
  const comissao=-somarTaxa('platform_commission_amount');
  const afiliado=-['affiliate_commission_amount','affiliate_partner_commission_amount','affiliate_ads_commission_amount'].reduce((s,k)=>s+somarTaxa(k),0);
  // fee_amount já inclui as comissões: separar sem somar duas vezes.
  const temTotal=tx.every(x=>x.fee_amount!=null || x.fee_and_tax_amount!=null);
  const total=temTotal ? -tx.reduce((s,x)=>s+n(x.fee_amount ?? x.fee_and_tax_amount),0) : null;
  const componentes={};
  for (const x of tx) {
    const fee=x.fee_tax_breakdown?.fee || x.fee_breakdown;
    const tax=x.fee_tax_breakdown?.tax;
    const campos=fee ? {...fee,...(tax || {})} : Object.fromEntries(Object.entries(x).filter(([k])=> /commission|service_fee|transaction_fee|fee_per_item|referral_fee/.test(k) && !['fee_amount','fee_and_tax_amount'].includes(k)));
    for (const [k,v] of Object.entries(campos)) if (!['fee_amount','fee_and_tax_amount','total_amount'].includes(k) && v != null && typeof v!=='object' && Number.isFinite(+v) && +v!==0) componentes[k]=r((componentes[k] || 0)-n(v));
  }
  const discriminado=Object.values(componentes).reduce((s,v)=>s+v,0);
  return {liquido:r(soma('settlement_amount')),taxas:{versao_tiktok:3,componentes,fee_total:total==null?null:r(total),nao_discriminado:total==null?null:r(total-discriminado),comissao:r(comissao),comissao_afiliado:r(afiliado),taxa_servico:total==null?null:r(total-comissao-afiliado),frete_vendedor:r(-soma('shipping_fee_amount')-soma('customer_shipping_fee_amount'))}};
}
module.exports={normalizarAcertoTikTok};
