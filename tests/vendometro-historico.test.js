const {test}=require('node:test'),assert=require('node:assert/strict');
const {buscar}=require('../js/vendometro-historico');
test('ML paginates, deduplicates and respects BRT day boundaries',async()=>{
 const calls=[];
 const rows=Array.from({length:50},(_,i)=>({id:i+1,date_created:'2026-07-07T13:00:00Z',status:'paid',total_amount:10,order_items:[]}));
 const out=await buscar(async(a,p)=>{calls.push(p);return{data:{results:p.offset?[rows[0],{...rows[0],id:999,date_created:'2026-07-08T03:00:00Z'}]:rows,paging:{total:52}}}}, {mkt:'ml',id:'A'},'2026-07-07');
 assert.equal(out.length,50);assert.equal(calls[1].offset,50);assert.equal(calls[0].date_from,'2026-07-07');
});
test('missing or malformed history is rejected rather than presented as zero',async()=>{
 await assert.rejects(buscar(async()=>({data:{}}),{mkt:'ml',id:'A'},'2026-07-07'),/incompleto/);
 await assert.rejects(buscar(async()=>({data:{response:{error:'invalid_time'}}}),{mkt:'shopee',id:'S'},'2026-07-07'),/disponibilizou/);
 await assert.rejects(buscar(async()=>({}),{mkt:'amazon',id:'X'},'2026-07-07'),/plataforma/);
});
test('Shopee follows cursors, fetches complete details and excludes cancelled orders',async()=>{
 const calls=[];
 const rows=[{order_sn:'a',create_time:Date.parse('2026-07-07T03:00:00Z')/1000,order_status:'COMPLETED',total_amount:120,item_list:[{model_discounted_price:50,model_quantity_purchased:2}]},{order_sn:'b',create_time:Date.parse('2026-07-07T14:00:00Z')/1000,order_status:'CANCELLED'}];
 const out=await buscar(async(a,p)=>{calls.push({a,p});return{data:{response:a==='shopee_get_order_detail'?{order_list:rows}:p.cursor?{order_list:[{order_sn:'b'}],more:false}:{order_list:[{order_sn:'a'}],more:true,next_cursor:'next'}}}}, {mkt:'shopee',id:'S'},'2026-07-07');
 assert.equal(out.length,1);assert.equal(out[0].valor_bruto,100);assert.equal(calls[0].p.time_from,Date.parse('2026-07-07T03:00:00Z')/1000);assert.equal(calls[1].p.cursor,'next');
});
test('missing details, repeated cursors and superseded requests fail closed',async()=>{
 await assert.rejects(buscar(async(a)=>({data:{response:a==='shopee_list_orders'?{order_list:[{order_sn:'a'}]}:{order_list:[]}}}),{mkt:'shopee',id:'S'},'2026-07-07'),/Faltam detalhes/);
 await assert.rejects(buscar(async()=>({data:{response:{order_list:[],more:true,next_cursor:'same'}}}),{mkt:'shopee',id:'S'},'2026-07-07'),/Paginação/);
 let calls=0;await assert.rejects(buscar(async()=>{calls++},{mkt:'ml',id:'A'},'2026-07-07',()=>false),/substituída/);assert.equal(calls,0);
});
