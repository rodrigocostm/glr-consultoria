const {test}=require('node:test');const assert=require('node:assert/strict');const c=require('../api/_push-core');
test('preferências validam horários, categorias e filtros',()=>{const p=c.preferencias({vendas:false,inicio:100,fim:-1,contas:['a','a',55]});assert.equal(p.vendas,false);assert.equal(p.saldo,true);assert.deepEqual(p.contas,['a']);assert.equal(p.inicio,23);assert.equal(p.fim,7);});
test('silêncio cruza meia-noite em Brasília e pode ser desligado',()=>{const p=c.preferencias();assert.equal(c.silencioso(p,new Date('2026-11-23T03:00:00Z')),true);assert.equal(c.silencioso(p,new Date('2026-11-23T13:00:00Z')),false);assert.equal(c.silencioso({...p,silencio:false},new Date('2026-11-23T03:00:00Z')),false);});
test('Shopee paga notifica sem aguardar conclusão; não pago e cancelado não entram',()=>{for(const s of ['READY_TO_SHIP','PROCESSED','SHIPPED','COMPLETED'])assert.equal(c.vendaValida({situacao:'valido',status_original:s}),true);for(const s of ['UNPAID','CANCELLED','PENDING_PAYMENT'])assert.equal(c.vendaValida({situacao:'valido',status_original:s}),false);assert.equal(c.vendaValida({situacao:'cancelado',status_original:'COMPLETED'}),false);});
test('filtro de contas não vaza resumo de cliente com contas não selecionadas',()=>{const p=c.preferencias({contas:['a']});assert.equal(c.permite(p,{categoria:'vendas',contas:['a']}),true);assert.equal(c.permite(p,{categoria:'metas',contas:['a','b']}),false);assert.equal(c.permite({...p,saldo:false},{categoria:'saldo',contas:['a']}),false);});
test('identidade de venda distingue plataforma e conta e não inventa lucro',()=>{const p={marketplace:'tiktok',conta_id:'a',pedido_id:'1',valor_bruto:159,criado_em:'2026-11-23'};const a=c.eventoPedido(p);assert.notEqual(a.chave,c.eventoPedido({...p,marketplace:'ml'}).chave);assert.equal(a.valor,159);assert.equal(a.lucro,undefined);});
test('saldo, metas e agente têm categoria e identificador de deduplicação',()=>{assert.equal(c.eventoAgente({id:1,dados:{acao:'saldo_ads'}}).categoria,'saldo');assert.equal(c.eventoAgente({id:2,dados:{colaboracao:{de:'meta'}}}).categoria,'metas');assert.equal(c.eventoAgente({id:3,dados:{acao:'estoque'}}).chave,'agente:3');});
test('rotina agrupa vendas, ignora histórico anterior à inscrição e deduplica',async()=>{
 const dbModule=require('../api/_push-db');const auth=require('../api/_auth');const old=auth.cronAuthorized;auth.cronAuthorized=()=>true;
 let enviados=0;const claims=new Set(),agora=new Date(),inscrito=new Date(agora-10000).toISOString();
 dbModule.usuarioPerfil=async()=>({tipo:'portal',contas:['a']});
 dbModule.vapid=()=>({sendNotification:async(_,payload)=>{enviados++;const d=JSON.parse(payload);assert.match(d.body,/2 pedido/);assert.ok(!d.body.includes('Margem:'));}});
 dbModule.config=async k=>k==='glr_clientes'?[]:{};
 const p=(id,em)=>({marketplace:'shopee',conta_id:'a',pedido_id:id,criado_em:em,situacao:'valido',status_original:'READY_TO_SHIP',valor_bruto:100});
 dbModule.db=async(path,opt)=>{
 if(path==='push_subscriptions?select=*')return [{endpoint:'e',user_id:'u',criado_em:inscrito,preferencias:{silencio:false}}];
 if(path.startsWith('glr_staff'))return [{user_id:'u'}];
 if(path.startsWith('glr_ads_diario'))return [];
 if(path.startsWith('glr_pedidos'))return [p('1',agora.toISOString()),p('2',agora.toISOString()),p('old',new Date(agora-20000).toISOString())];
 if(path.startsWith('glr_agente_log')||path.startsWith('glr_sync_estado'))return [];
 if(path.startsWith('push_deliveries')&&opt?.method==='POST'){const rows=JSON.parse(opt.body).filter(x=>!claims.has(x.evento));rows.forEach(x=>claims.add(x.evento));return rows;}
 return [];
 };
 dbModule.listar=dbModule.db;
 delete require.cache[require.resolve('../api/push-cron')];const handler=require('../api/push-cron');
 const r=()=>({status(c){this.code=c;return this;},json(b){this.body=b;}});const a=r();await handler({},a);assert.equal(a.body.enviados,1);const b=r();await handler({},b);assert.equal(b.body.enviados,0);assert.equal(enviados,1);auth.cronAuthorized=old;
});

