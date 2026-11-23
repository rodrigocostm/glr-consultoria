const CATEGORIAS=['vendas','saldo','metas','agentes'];
const PADRAO={vendas:true,saldo:true,metas:true,agentes:true,contas:[],silencio:true,inicio:23,fim:7};
const dinheiro=n=>'R$ '+(+n||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
function preferencias(p={}) {return {...Object.fromEntries(CATEGORIAS.map(k=>[k,p[k]!==false])),contas:Array.isArray(p.contas)?[...new Set(p.contas.filter(x=>typeof x==='string').map(x=>x.slice(0,200)))].slice(0,300):[],silencio:p.silencio!==false,inicio:Number.isInteger(p.inicio)&&p.inicio>=0&&p.inicio<=23?p.inicio:23,fim:Number.isInteger(p.fim)&&p.fim>=0&&p.fim<=23?p.fim:7};}
function silencioso(p,agora=new Date()){if(!p.silencio)return false;const hora=+new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',hourCycle:'h23'}).format(agora);return p.inicio===p.fim?false:p.inicio>p.fim?hora>=p.inicio||hora<p.fim:hora>=p.inicio&&hora<p.fim;}
function vendaValida(p){if(p.situacao!=='valido')return false;const s=String(p.status_original||'').toUpperCase();return !!s&&!/UNPAID|PENDING|AWAITING_PAYMENT|CANCEL|INVALID|INCOMPLETE|ON_HOLD/.test(s);}
function permite(p,e){return !!p[e.categoria]&&(!p.contas.length||e.contas?.length&&e.contas.every(id=>p.contas.includes(String(id))));}
function eventoPedido(p){return {chave:`venda:${p.marketplace}:${p.conta_id}:${p.pedido_id}`,categoria:'vendas',contas:[String(p.conta_id)],em:p.criado_em,valor:+p.valor_bruto||0,plataforma:p.marketplace};}
function eventoAgente(l){const d=l.dados||{};const categoria=d.acao==='saldo_ads'?'saldo':d.colaboracao?.de==='meta'||String(d.acao||'').includes('meta')?'metas':'agentes';return {chave:'agente:'+l.id,categoria,contas:[String(l.conta_id)],em:l.criado_em,titulo:l.titulo,texto:String(l.explicacao||'').slice(0,180)};}
module.exports={CATEGORIAS,PADRAO,preferencias,silencioso,vendaValida,permite,eventoPedido,eventoAgente,dinheiro};
