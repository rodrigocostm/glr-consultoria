const { requireStaff } = require('./_auth');
const { db, listar } = require('./_conhecimento');
const uuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || '');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Método inválido.'});
  const user = await requireStaff(req,res); if (!user) return;
  try {
    if (req.method === 'GET') {
      if (req.query?.id) {
        if (!uuid(req.query.id)) return res.status(400).json({error:'Nota inválida.'});
        const rows = await db(`?id=eq.${req.query.id}&select=*`);
        return rows[0] ? res.json({nota:rows[0]}) : res.status(404).json({error:'Nota não encontrada.'});
      }
      return res.json({notas:await listar()});
    }
    const b = req.body || {};
    if (!uuid(b.id) || typeof b.titulo !== 'string' || !b.titulo.trim() || b.titulo.trim().length > 160 || /[\[\]\n\r]/.test(b.titulo) || typeof b.conteudo !== 'string' || b.conteudo.length > 40000 || !['rascunho','publicado','arquivado'].includes(b.estado) || !Number.isInteger(b.versao) || b.versao < 0 || !Array.isArray(b.tags) || b.tags.length > 12 || b.tags.some(t => typeof t !== 'string' || t.length > 40) || typeof b.categoria !== 'string' || b.categoria.length > 60) return res.status(400).json({error:'Revise os campos da nota. O texto permanece no editor.'});
    if (b.estado === 'publicado' && !b.conteudo.trim()) return res.status(400).json({error:'Escreva o conteúdo antes de publicar para os agentes.'});
    const old = (await db(`?id=eq.${b.id}&select=*`))[0];
    if (old && old.versao !== b.versao || !old && b.versao !== 0) return res.status(409).json({error:'Esta nota mudou em outra sessão. Seu rascunho foi mantido. Abra a versão salva antes de conciliar as alterações.'});
    const historico = old ? [...old.historico, Object.fromEntries(Object.entries(old).filter(([k]) => k !== 'historico'))].slice(-50) : [];
    const row = {id:b.id,titulo:b.titulo.trim(),conteudo:b.conteudo,categoria:b.categoria.trim() || 'Operação',tags:[...new Set(b.tags.map(t=>t.trim()).filter(Boolean))],estado:b.estado,versao:(old?.versao || 0)+1,historico,atualizado_em:new Date().toISOString(),atualizado_por:user.id};
    const saved = await db(old ? `?id=eq.${b.id}&versao=eq.${b.versao}` : '', {method:old?'PATCH':'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(row)});
    if (!saved?.length) return res.status(409).json({error:'Outro gestor salvou primeiro. Seu rascunho foi mantido; abra a versão salva para comparar.'});
    return res.json({nota:saved[0]});
  } catch(e) { return res.status(e.status || 503).json({error:e.message}); }
};
