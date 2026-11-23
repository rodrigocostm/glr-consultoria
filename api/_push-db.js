const URL='https://rrodqlejqyaoomutriiw.supabase.co/rest/v1/';
async function db(path,options={}){const key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!key)throw Error('Banco indisponível');const r=await fetch(URL+path,{...options,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Banco de notificações: '+r.status);return r.status===204?null:r.json().catch(()=>null);}
async function config(chave){return (await db('glr_storage?chave=eq.'+encodeURIComponent(chave)+'&select=dados'))?.[0]?.dados;}
function vapid(){if(!process.env.VAPID_PUBLIC_KEY||!process.env.VAPID_PRIVATE_KEY)throw Error('Envio push ainda não configurado no servidor');const w=require('web-push');w.setVapidDetails('mailto:contato@consultoriaglr.com.br',process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);return w;}
async function usuarioAtivo(id,portais=[]) {
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 const r=await fetch('https://rrodqlejqyaoomutriiw.supabase.co/auth/v1/admin/users/'+encodeURIComponent(id),{headers:{apikey:key,Authorization:'Bearer '+key},signal:AbortSignal.timeout(10000)});
 if(!r.ok)return false;const u=await r.json();
 return !!u.id && !(u.banned_until && Date.parse(u.banned_until)>Date.now()) && !portais.some(p=>String(p.email||'').toLowerCase()===String(u.email||'').toLowerCase());
}
module.exports={db,config,vapid,usuarioAtivo};
