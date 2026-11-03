// Small durable outbox, separate from the synchronized collection. Never overwritten by realtime.
window.glrSalvarAcoes = async function(items, removed=[]) {
 const {data}=await _sb.auth.getSession();const uid=data?.session?.user?.id;
 if(!uid)throw Error('Entre novamente. O formulário permanece aberto.');
 const pendingKey='glr_acoes_pendentes_'+uid;
 let pending={};try{pending=JSON.parse(localStorage.getItem(pendingKey)||'{}')}catch{}
 const operation={items,removed},opId=crypto.randomUUID();pending[opId]=operation;
 try{_localSetItem(pendingKey,JSON.stringify(pending));}catch{throw Error('Sem espaço para proteger o lançamento neste navegador. O formulário permanece aberto.');}
 const r=await glrApiFetch('/api/report-actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(operation)});
 const result=await r.json();if(!r.ok||!result.ok)throw Error(result.error||'Gravação não confirmada. Lançamento pendente preservado.');
 // Only this operation is acknowledged: keep other tabs' pending work.
 try{pending=JSON.parse(localStorage.getItem(pendingKey)||'{}');delete pending[opId];
  for (const [id,old] of Object.entries(pending)) if ((old.items||[]).length && (old.items||[]).every(x=>items.some(n=>String(n.id)===String(x.id)))) delete pending[id];
  _localSetItem(pendingKey,JSON.stringify(pending));}catch{}
 GLR.acoes=result.items;_baseSync.glr_acoes=result.items;
 try{_localSetItem('glr_acoes',JSON.stringify(result.items));}catch{}
 return result;
};
window.glrRecuperarAcoesPendentes = async function(){
 const {data}=await _sb.auth.getSession();const uid=data?.session?.user?.id;if(!uid||window._portalConfig)return;
 const k='glr_acoes_pendentes_'+uid;let pending;try{pending=JSON.parse(localStorage.getItem(k)||'{}')}catch{return}
 for(const[id,operation]of Object.entries(pending)){
  try{const r=await glrApiFetch('/api/report-actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(operation)});const j=await r.json();if(!r.ok||!j.ok)break;
   const latest=JSON.parse(localStorage.getItem(k)||'{}');delete latest[id];_localSetItem(k,JSON.stringify(latest));GLR.acoes=j.items;_baseSync.glr_acoes=j.items;_localSetItem('glr_acoes',JSON.stringify(j.items));
  }catch{break}
 }
};
window.addEventListener('online',()=>window.glrRecuperarAcoesPendentes().catch(()=>{}));
