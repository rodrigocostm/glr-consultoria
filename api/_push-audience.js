const core=require('./_push-core');
const mkt=m=>['meli','mercadolivre','ml'].includes(String(m).toLowerCase())?'ml':['tiktok_shop','tiktokshop'].includes(m)?'tiktok':m;
function perfilUsuario(u,portais,staff){
 if(!u?.id || u.banned_until&&Date.parse(u.banned_until)>Date.now())return null;
 const encontrados=(portais||[]).filter(p=>String(p.email||'').toLowerCase()===String(u.email||'').toLowerCase());
 if(encontrados.length){if(encontrados.some(p=>String(p.ativo)==='false'))return null;const p=encontrados[0];return {tipo:'portal',contas:(p.contaIds||[]).map(String)};}
 return staff.has(String(u.id))?{tipo:'consultoria',contas:null}:null;
}
function preferencias(p,tipo){const base=core.preferencias(p);return {...base,vendometro:p?.vendometro!==false,oscilacao:p?.oscilacao!==false,...(tipo==='consultoria'?{vendas:false,metas:false,agentes:false}:{vendometro:false,agentes:false})};}
function autorizado(perfil,p,e){if(!perfil)return false;if(!(perfil.tipo==='consultoria'?['vendometro','saldo','oscilacao']:['vendas','saldo','metas']).includes(e.categoria))return false;if(perfil.tipo==='portal'&&(!e.contas?.length||!e.contas.every(id=>perfil.contas.includes(String(id)))))return false;return !!p[e.categoria]&&(!p.contas.length||e.contas.every(id=>p.contas.includes(String(id))));}
function carteira(vinc,clientes,selecionadas=[]){const ativos=new Set((clientes||[]).map(c=>String(c.id)));const mapa=new Map();for(const [cli,lista]of Object.entries(vinc||{})){if(!ativos.has(cli))continue;for(const c of lista||[]){const id=String(c.param_to_use?.shopId||c.param_to_use?.meliUserId||c.contaId||c.external_id);if(selecionadas.length&&!selecionadas.includes(id))continue;mapa.set(mkt(c.marketplace)+':'+id,{id,mkt:mkt(c.marketplace),nome:c.tags?.[0]?.name||c.nickname||id});}}return mapa;}
function resumoVendometro(pedidos,ads,contas,agora,cobertura=false){
 const dia=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(agora);
 const inicio=Date.parse(dia+'T00:00:00-03:00'),hora=Math.floor((+agora-inicio)/3600e3);const janela=[9,13,18,22].filter(h=>h<=hora).pop();if(janela==null)return null;
 const corte=inicio+janela*3600e3;let fat=0,ant=0,qtd=0,gasto=0;
 for(const p of pedidos){if(p.situacao!=='valido'||!contas.has(mkt(p.marketplace)+':'+p.conta_id))continue;const t=Date.parse(p.criado_em);if(t>=inicio&&t<=corte){fat+=+p.valor_bruto||0;qtd++;}if(t>=inicio-864e5&&t<=corte-864e5)ant+=+p.valor_bruto||0;}
 for(const a of ads)if(a.data===dia&&contas.has(mkt(a.marketplace)+':'+a.conta_id))gasto+=+a.gasto||0;
 const variacao=ant>0?`${fat>=ant?'+':''}${((fat/ant-1)*100).toFixed(1)}%`:'sem base positiva para percentual';
 return {chave:`vendometro:${dia}:${janela}`,categoria:'vendometro',contas:[...new Set([...contas.values()].map(c=>c.id))],em:new Date(corte).toISOString(),titulo:`Vendômetro · ${String(janela).padStart(2,'0')}h`,texto:`Carteira: ${core.dinheiro(fat)} em ${qtd} pedidos até ${janela}h. ${cobertura?`Ontem até ${janela}h: ${core.dinheiro(ant)} (${variacao}).`:'Comparativo indisponível: histórico incompleto.'} ADS hoje na base: ${core.dinheiro(gasto)}. Valores sujeitos à sincronização.`,url:'/index.html#vendometro'};
}
function oscilacoes(ads,contas,agora){
 const dia=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(agora),inicio=Date.parse(dia+'T00:00:00-03:00');const data=n=>new Date(inicio-n*864e5).toISOString().slice(0,10),out=[];
 for(const [k,c]of contas){const dias=new Map();for(const a of ads)if(mkt(a.marketplace)+':'+a.conta_id===k)dias.set(a.data,(dias.get(a.data)||0)+(+a.gasto||0));if(!Array.from({length:8},(_,i)=>data(i+1)).every(d=>dias.has(d)))continue;const ontem=dias.get(data(1)),media=Array.from({length:7},(_,i)=>dias.get(data(i+2))).reduce((s,v)=>s+v,0)/7;const delta=ontem-media;if(Math.abs(delta)<100||media>0&&Math.abs(delta/media)<.5)continue;
 out.push({chave:'oscilacao:'+k+':'+data(1),categoria:'oscilacao',contas:[c.id],em:new Date(inicio).toISOString(),titulo:c.nome,texto:`ADS ontem: ${core.dinheiro(ontem)}; média dos 7 dias anteriores: ${core.dinheiro(media)}. ${media>0?`${delta>=0?'+':''}${(delta/media*100).toFixed(0)}%`:'Sem gasto na referência'}. Revisar orçamento e campanhas.`,url:'/index.html#vendometro'});
 }return out;
}
module.exports={perfilUsuario,preferencias,autorizado,carteira,resumoVendometro,oscilacoes};
