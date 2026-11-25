(function(root){
 const value=x=>{const n=Number(x);return Number.isFinite(n)&&n>0?n:0;};
 function resolve({itens=[],catalogo={},produtos=[],clienteId,mkt,contaId,manual=0}){
 const qtd=i=>Math.max(1,parseInt(i.qtd)||1),quantidade=itens.reduce((s,i)=>s+qtd(i),0)||1;if(value(manual))return {total:value(manual)*quantidade,completo:true,origem:'pedido'};
 let total=0,pendentes=0;
 for(const i of itens){const id=String(i.item_id||i.itemId||i.shopeeItemId||''),sku=String(i.sku||'').trim().toUpperCase();let unit=0;for(const k of (mkt==='ml'?[id,i.nome]:[i.nome,id]).filter(Boolean)){unit=value(catalogo[k]);if(unit)break;}
 if(!unit&&clienteId){const daEmpresa=produtos.filter(p=>String(p.clienteId)===String(clienteId));const associados=daEmpresa.filter(p=>(p.anuncios||[]).some(a=>String(a.id)===id&&a.mkt===mkt&&String(a.conta)===String(contaId)));const candidatos=associados.length?associados:sku?daEmpresa.filter(p=>String(p.sku||'').trim().toUpperCase()===sku):[];const custos=candidatos.map(p=>value(Number(p.custo||0)+Number(p.custoExtra||0)));const unicos=[...new Set(custos)];if(unicos.length===1&&unicos[0]>0)unit=unicos[0];}
 if(!unit)pendentes++;total+=unit*qtd(i);
 }return {total,completo:itens.length>0&&pendentes===0,pendentes,origem:total?'cadastro':'nenhum'};
 }
 const api={resolve};if(typeof module!=='undefined')module.exports=api;else root.GLRProductCost=api;
})(globalThis);
