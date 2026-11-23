const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
test('central escapa dados externos e abrir apenas marca leitura e navega',async()=>{
 const calls=[],paths=[],row={id:'id1',categoria:'curva_a',titulo:'<script>teste</script>',texto:'<img onerror=x>',contas:['a'],destino:'estoque-margem',criado_em:'2026-11-23T10:00:00Z'};
 const el={isConnected:true,innerHTML:''};
 const ctx={window:{},document:{hidden:false,getElementById:()=>null},GLR:{ctx:{}},Router:{register(){},navigate:p=>paths.push(p)},_sb:{auth:{getSession:async()=>({data:{session:{access_token:'token'}}})}},fetch:async(url,o)=>{calls.push([url,o]);return {ok:true,json:async()=>o.method==='POST'?{ok:true}:{rows:[row],totais:{nao_lidas:1,pendentes:1},mais:false}};},setInterval:()=>1,clearInterval(){},setTimeout(){},Date,console};
 vm.runInNewContext(fs.readFileSync(require.resolve('../js/notification-center.js'),'utf8')+';window.N=NotificationCenter;',ctx);ctx.window.N.mount(el);await new Promise(setImmediate);
 assert.ok(el.innerHTML.includes('&lt;script&gt;'));assert.ok(!el.innerHTML.includes('<script>'));assert.ok(el.innerHTML.includes('Marcar tratada'));
 await el.onclick({target:{closest:()=>({dataset:{act:'open',id:'id1'}})}});assert.deepEqual(paths,['estoque-margem']);const req=calls.find(([,o])=>o.method==='POST');assert.equal(req[0],'/api/notifications');assert.equal(JSON.parse(req[1].body).action,'read');
});
