const URL='https://rrodqlejqyaoomutriiw.supabase.co/rest/v1/';
async function db(path,options={}){const key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!key)throw Error('Banco indisponível');const r=await fetch(URL+path,{...options,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Banco de notificações: '+r.status);return r.status===204?null:r.json().catch(()=>null);}
async function listar(path,max=30000){
 const out=[];for(let off=0;off<max;off+=1000){const page=await db(path+'&limit=1000&offset='+off);if(!Array.isArray(page))throw Error('Resposta de notificações inválida');out.push(...page);if(page.length<1000)return out;}throw Error('Dados acima do limite de leitura; resumo interrompido');
}
async function config(chave){return (await db('glr_storage?chave=eq.'+encodeURIComponent(chave)+'&select=dados'))?.[0]?.dados;}
function vapid(){if(!process.env.VAPID_PUBLIC_KEY||!process.env.VAPID_PRIVATE_KEY)throw Error('Envio push ainda não configurado no servidor');const w=require('web-push');w.setVapidDetails('mailto:contato@consultoriaglr.com.br',process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);return w;}
async function usuarioPerfil(id,portais=[],staff=new Set()) {
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 const r=await fetch('https://rrodqlejqyaoomutriiw.supabase.co/auth/v1/admin/users/'+encodeURIComponent(id),{headers:{apikey:key,Authorization:'Bearer '+key},signal:AbortSignal.timeout(10000)});
 if(!r.ok)return null;const u=await r.json();
 return require('./_push-audience').perfilUsuario(u,portais,staff);
}
module.exports={db,listar,config,vapid,usuarioPerfil};

