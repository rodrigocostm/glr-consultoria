import{test}from'node:test';import assert from'node:assert/strict';import{command,liveEvent}from'./routing.mjs';const m=(jid='g@g.us',own=true,text='!adviser teste')=>({key:{remoteJid:jid,fromMe:own,id:'1'},message:{conversation:text}});
test('isola grupo; ignora duplicatas',()=>{assert.equal(command(m(),'',new Set()),null);assert.equal(command(m('private@s.whatsapp.net'),'g@g.us',new Set()),null);assert.equal(command(m(undefined,false),'g@g.us',new Set()).agent,'adviser');assert.equal(command(m(),'g@g.us',new Set(['1'])),null);assert.equal(command(m(),'g@g.us',new Set()).agent,'adviser');});
test('ignora mensagens comuns e ecos dos bots',()=>{for(const s of ['olá','[GLR • Adviser]\n!gerente oi','!unknown oi','!ml ','!ml '+'a'.repeat(6001)])assert.equal(command(m(undefined,true,s),'g@g.us',new Set()),null);});
test('roteia persona com pergunta multilinha',()=>{const c=command(m(undefined,true,'!gerente Mega Facil\nAnalise'),'g@g.us',new Set());assert.equal(c.agent,'esc:gerente');assert.equal(c.question,'Mega Facil\nAnalise');});

test('participantes da equipe podem chamar agentes e testar conexão',()=>{
 for(const own of [true,false]){
  const msg=m(undefined,own,'!gerente faturamento de hoje?');
  msg.key.participant='pessoa@lid';
  assert.equal(command(msg,'g@g.us',new Set()).agent,'esc:gerente');
  assert.equal(command(m(undefined,own,'!ping'),'g@g.us',new Set()).alias,'ping');
 }
 assert.equal(command(m('outro@g.us',false),'g@g.us',new Set()),null);
 assert.equal(command(m('pessoa@s.whatsapp.net',false),'pessoa@s.whatsapp.net',new Set()),null);
});
test('aceita eventos novos e ignora histórico antigo',()=>{
 const now=Math.floor(Date.now()/1000);
 assert.equal(liveEvent({messageTimestamp:now},'notify',now),true);
 assert.equal(liveEvent({messageTimestamp:now},'append',now),true);
 assert.equal(liveEvent({messageTimestamp:now-1},'append',now),false);
 assert.equal(liveEvent({},'append',now),false);
});
