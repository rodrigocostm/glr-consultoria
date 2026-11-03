const {requireStaff}=require('./_auth');
const BASE='https://rrodqlejqyaoomutriiw.supabase.co/rest/v1/glr_storage';
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','private, no-store');
 if(req.method!=='POST')return res.status(405).json({error:'Método inválido.'});
 const user=await requireStaff(req,res);if(!user)return;
 const {items=[],removed=[]}=req.body||{};
 if(!Array.isArray(items)||!Array.isArray(removed)||items.length>100||removed.length>100||items.some(x=>!x||!/^\d+$/.test(String(x.id))||typeof x.descricao!=='string'||!x.descricao.trim()||x.descricao.length>50000))return res.status(400).json({error:'Ação inválida. O texto não foi descartado.'});
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY,headers={apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
 try{
  for(let attempt=0;attempt<6;attempt++){
   const r=await fetch(BASE+'?chave=eq.glr_acoes&select=dados,atualizado_em',{headers,signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error();
   const rows=await r.json(),row=rows[0];
   if(!row)return res.status(409).json({error:'Coleção indisponível. Seus dados permanecem pendentes; não recrie a coleção.'});
   if(!Array.isArray(row.dados))throw Error();
   const data=row.dados.slice();
   // Deletion is explicit; a stale browser list can never silently delete reports.
   for(const id of removed){const idx=data.findIndex(x=>String(x.id)===String(id));if(idx>=0)data.splice(idx,1);}
   for(const item of items){
    const idx=data.findIndex(x=>String(x.id)===String(item.id));
    const clean=Object.fromEntries(['id','clienteId','data','categoria','descricao','responsavel','status'].filter(k=>item[k]!==undefined).map(k=>[k,item[k]]));
    if(idx<0)data.push({...clean,registradoPor:user.id});
    else if(Object.keys(clean).some(k=>JSON.stringify(clean[k])!==JSON.stringify(data[idx][k]))){
     const {_historico=[],...anterior}=data[idx];
     data[idx]={...data[idx],...clean,_historico:[..._historico,{...anterior,arquivadoEm:new Date().toISOString(),editadoPor:user.id}]};
    }
   }
   const version=row.atualizado_em==null?'atualizado_em=is.null':`atualizado_em=eq.${encodeURIComponent(row.atualizado_em)}`;
   const w=await fetch(`${BASE}?chave=eq.glr_acoes&${version}`,{method:'PATCH',headers:{...headers,Prefer:'return=representation'},body:JSON.stringify({dados:data,atualizado_em:new Date().toISOString()}),signal:AbortSignal.timeout(15000)});
   if(!w.ok)throw Error();
   if((await w.json()).length)return res.status(200).json({ok:true,items:data});
  }
  return res.status(409).json({error:'Outros gestores estão salvando. Tente novamente; seu texto permanece pendente.'});
 }catch{return res.status(503).json({error:'Não foi possível confirmar a gravação. Seus dados permanecem pendentes; tente novamente.'});}
};
