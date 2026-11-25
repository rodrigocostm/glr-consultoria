module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','private, no-store');const user=await require('./_auth').requireStaff(req,res);if(!user)return;
 const pb=require('./_playbook'),{db}=require('./_push-db');
 try{const [ctx,rows]=await Promise.all([pb.contexto(),pb.registros()]);if(req.method==='GET'){const history=await require('./_playbook-history').history(ctx,require('./_push-db').listar);return res.json({...ctx,rows,pendencias:pb.pendencias(rows),...history});}if(req.method!=='POST')return res.status(405).json({error:'Método inválido'});if(Buffer.byteLength(JSON.stringify(req.body||{}))>32000)return res.status(413).json({error:'Registro muito grande'});
 const row=pb.preparar(req.body||{},ctx,rows,user);const saved=await db('glr_playbook_records?on_conflict=origem,janela',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify(row)});return res.json({ok:true,registro:saved?.[0]||null});
 }catch(e){console.error('[playbook]',e.message);return res.status(400).json({error:e.message||'Falha ao carregar playbook'});}
};

