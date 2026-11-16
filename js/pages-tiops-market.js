Router.register('mercado-tiops', async(params,el)=>{
 if(window._portalConfig){Router.navigate('meu-dashboard');return;}
 const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 // contas do ML para o Tiops ler a API: primeiro as do cliente em foco, depois as outras da carteira
 const contasML=()=>{let v={};try{v=JSON.parse(localStorage.getItem('glr_mc_vinculos')||'{}');}catch(e){}
  const foco=String(GLR?.ctx?.cliente?.()||''),ml=c=>/meli|mercado|^ml$/i.test(String(c.marketplace||'')),id=c=>String(c.param_to_use?.meliUserId||c.external_id||'');
  const doFoco=(v[foco]||[]).filter(ml).map(id),resto=Object.entries(v).filter(([k])=>k!==foco).flatMap(([,cs])=>(cs||[]).filter(ml).map(id));
  return [...new Set([...doFoco,...resto])].filter(Boolean).slice(0,6);};
 const pq={termo:'',cats:null,cat:null,aba:'vendidos',res:{},busy:false,erro:''};
 const names={ml_trends:'Termos em alta',ml_highlights:'Mais vendidos',get_item:'Anúncio concorrente',get_description:'Descrição do anúncio',get_product:'Produto de catálogo',product_items:'Ofertas concorrentes',ml_catalog_search_products:'Pesquisar catálogo',search_sellers:'Pesquisar vendedores',ml_catalog_buybox:'Diagnóstico Buy Box',ml_catalog_price_to_win:'Preço para ganhar Buy Box',ml_catalog_eligibility:'Elegibilidade de catálogo',ml_site_categories:'Categorias do Mercado Livre',search_categories:'Encontrar categoria'};
 let catalog=null,busy=false,latest=null;
 el.innerHTML=`<div class="page mk">
  <div class="mk-cab"><div><h2>Mercado e concorrência</h2><p>Veja o que mais vende e o que estão buscando no Mercado Livre, por categoria.</p></div>
   <button class="btn btn-ghost btn-sm" id="tm-chat" title="Peça uma análise em linguagem natural">Perguntar aos agentes →</button></div>
  <form class="mk-busca card" id="mk-form" autocomplete="off">
   <label for="mk-termo">Produto ou categoria</label>
   <div class="mk-linha" id="mk-linha"><input id="mk-termo" class="form-control" placeholder="Ex.: armário aéreo, rack para TV, cadeira gamer…" maxlength="120"><button class="btn btn-primary" id="mk-buscar">Buscar categorias</button></div>
   <div id="mk-cats" class="mk-cats"></div>
  </form>
  <div id="mk-res"></div>
  <details class="mk-avancado card"><summary>Consulta avançada (direto no Tiops)</summary>
   <div id="tm-discovery" style="margin:10px 0"></div><button class="btn btn-secondary btn-sm" id="tm-discover" type="button">Verificar novidades na conexão</button>
   <form id="tm-form" style="margin-top:16px"><label for="tm-action">Consulta</label><select id="tm-action" class="form-control" style="width:100%;margin:8px 0 12px"><option>Carregando consultas…</option></select><p id="tm-desc" class="mk-sub"></p><div id="tm-fields" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px"></div><button id="tm-run" class="btn btn-primary btn-sm" style="margin-top:14px" disabled>Consultar</button></form>
   <p id="tm-status" role="status" aria-live="polite" class="mk-sub"></p><div id="tm-results"></div></details>
 </div>
 <style>
  .mk{display:flex;flex-direction:column;gap:16px;max-width:1100px}
  .mk-cab{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap} .mk-cab h2{margin:0;font-size:20px} .mk-cab p{margin:4px 0 0;color:var(--text-muted);font-size:13.5px}
  .mk-busca{padding:18px} .mk-busca label{font-size:12.5px;font-weight:600;color:var(--text-secondary)}
  .mk-linha{display:flex;gap:8px;margin-top:6px} .mk-linha input{flex:1;font-size:15px}
  .mk-cats{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px} .mk-cats:empty{display:none}
  .mk-cat{all:unset;cursor:pointer;display:flex;flex-direction:column;padding:7px 12px;border:1px solid var(--border);border-radius:10px;font-size:13px;color:var(--text-primary)} .mk-cat small{font-size:11px;color:var(--text-muted)}
  .mk-cat:hover{border-color:var(--accent)} .mk-cat.on{border-color:var(--accent);background:var(--accent-glow)} .mk-cat:focus-visible{outline:2px solid var(--accent)}
  .mk-sub{font-size:12.5px;color:var(--text-muted)} .mk-erro{color:var(--red);font-size:13px;padding:12px 2px}
  .mk-abas{display:flex;gap:4px;margin-bottom:12px} .mk-abas button{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit} .mk-abas button.on{border-color:var(--accent);background:var(--accent-glow);color:var(--text-primary);font-weight:600}
  .mk-grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
  .mk-item{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card);text-decoration:none;color:var(--text-primary);position:relative} .mk-item:hover{border-color:var(--accent)}
  .mk-item img{width:100%;aspect-ratio:1;object-fit:contain;background:#fff;border-radius:8px} .mk-ph{width:100%;aspect-ratio:1;border-radius:8px;background:var(--bg-subtle);display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-muted)}
  .mk-pos{position:absolute;top:8px;left:8px;background:var(--text-primary);color:var(--bg-base);font-size:11px;font-weight:700;border-radius:6px;padding:1px 7px}
  .mk-item b{font-size:12.5px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden} .mk-item small{font-size:11px;color:var(--text-muted)}
  .mk-termos{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px} .mk-col h4{margin:0 0 6px;font-size:13px} .mk-col ol{margin:0;padding-left:20px;font-size:13px;line-height:1.8} .mk-col a{color:var(--text-primary)}
  .mk-avancado{padding:14px 18px} .mk-avancado summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--text-secondary)}
  .mk-carr{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px} .mk-carr span{aspect-ratio:1;border-radius:12px;background:var(--bg-subtle);animation:mkp 1.2s infinite alternate} @keyframes mkp{to{opacity:.5}}
  @media (prefers-reduced-motion:reduce){.mk-carr span{animation:none}}
  @media (max-width:600px){.mk-linha{flex-direction:column}}
 </style>`;
 async function pesquisa(tipo,dados){const r=await glrApiFetch('/api/tiops-market',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'pesquisa',tipo,dados,contas:contasML()})});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Falha na consulta.');return j;}
 const vivo=()=>Router.currentPage==='mercado-tiops'&&!!el.querySelector('#mk-form');
 function desenharCats(){const box=el.querySelector('#mk-cats');if(!pq.cats){box.innerHTML='';return;}
  box.innerHTML=pq.cats.length?`<span class="mk-sub" style="width:100%">Escolha a categoria:</span>`+pq.cats.map(c=>`<button type="button" class="mk-cat ${pq.cat===c.id?'on':''}" data-cat="${h(c.id)}">${h(c.nome)}<small>${h(c.dominio||c.id)}</small></button>`).join(''):'<span class="mk-sub">Nenhuma categoria encontrada. Tente outro nome.</span>';
  box.querySelectorAll('.mk-cat').forEach(b=>b.onclick=()=>{pq.cat=b.dataset.cat;pq.res={};desenharCats();carregarAba();});}
 function desenharRes(){const box=el.querySelector('#mk-res');if(!pq.cat){box.innerHTML=pq.erro?`<div class="mk-erro">${h(pq.erro)}</div>`:'';return;}
  const nome=pq.cats?.find(c=>c.id===pq.cat)?.nome||pq.cat,r=pq.res[pq.aba];
  let corpo;
  if(pq.busy)corpo=`<div class="mk-carr">${'<span></span>'.repeat(8)}</div>`;
  else if(pq.erro)corpo=`<div class="mk-erro">${h(pq.erro)}</div>`;
  else if(!r)corpo='';
  else if(pq.aba==='vendidos')corpo=r.itens?.length?`<div class="mk-grade">${r.itens.map(x=>`<a class="mk-item" href="${h(x.link)}" target="_blank" rel="noopener"><span class="mk-pos">${x.pos}º</span>${x.foto?`<img src="${h(x.foto)}" alt="" loading="lazy">`:`<span class="mk-ph">${x.tipo==='PRODUCT'?'catálogo':'anúncio'}</span>`}<b>${h(x.nome||(x.tipo==='PRODUCT'?'Produto de catálogo':'Anúncio de vendedor'))}</b><small>${h(x.marca?x.marca+' · ':'')}${h(x.id)} · abrir no ML ↗</small></a>`).join('')}</div><p class="mk-sub">Ranking de mais vendidos do Mercado Livre. Anúncios de outros vendedores não mostram nome pela API — clique para ver no ML.</p>`:'<p class="mk-sub">O ML não retornou mais vendidos para esta categoria.</p>';
  else{const col=(t,a)=>a?.length?`<div class="mk-col"><h4>${t}</h4><ol>${a.map(x=>`<li><a href="${h(x.link)}" target="_blank" rel="noopener">${h(x.termo)}</a></li>`).join('')}</ol></div>`:'';
   const cols=col('Buscas crescendo',r.crescendo)+col('Mais buscados',r.buscados)+col('Crescendo em receita',r.receita);
   corpo=cols?`${r.usada?`<p class="mk-sub" style="margin-top:0">Esta categoria não teve termos nesta semana — mostrando a categoria de cima: <b>${h(r.usada.nome)}</b>.</p>`:''}<div class="mk-termos">${cols}</div><p class="mk-sub">Termos atualizados semanalmente pelo ML. Busca em alta não é venda garantida.</p>`:'<p class="mk-sub">Sem termos em alta para esta categoria nesta semana.</p>';}
  box.innerHTML=`<div class="card" style="padding:18px"><div class="mk-cab" style="margin-bottom:10px"><div><h2 style="font-size:16px">${h(nome)}</h2>${r?.em?`<p>Fonte: Mercado Livre via Tiops · ${new Date(r.em).toLocaleString('pt-BR')}</p>`:''}</div>
   <div class="mk-abas" role="tablist"><button type="button" role="tab" class="${pq.aba==='vendidos'?'on':''}" data-aba="vendidos">Mais vendidos</button><button type="button" role="tab" class="${pq.aba==='alta'?'on':''}" data-aba="alta">Termos em alta</button></div></div>${corpo}</div>`;
  box.querySelectorAll('[data-aba]').forEach(b=>b.onclick=()=>{pq.aba=b.dataset.aba;carregarAba();});}
 async function carregarAba(){if(!pq.cat)return;if(pq.res[pq.aba]){pq.erro='';desenharRes();return;}
  pq.busy=true;pq.erro='';desenharRes();
  try{const r=await pesquisa(pq.aba==='vendidos'?'mais_vendidos':'em_alta',{categoria:pq.cat});if(!vivo())return;pq.res[pq.aba]=r;}
  catch(e){pq.erro=e.message;}finally{pq.busy=false;if(vivo())desenharRes();}}
 el.querySelector('#mk-form').onsubmit=async e=>{e.preventDefault();const t=el.querySelector('#mk-termo').value.trim();if(t.length<2)return;
  const b=el.querySelector('#mk-buscar');b.disabled=true;b.textContent='Buscando…';pq.erro='';pq.cat=null;pq.res={};
  try{const r=await pesquisa('categorias',{termo:t});if(!vivo())return;pq.cats=r.categorias;if(pq.cats.length===1){pq.cat=pq.cats[0].id;}desenharCats();desenharRes();if(pq.cat)carregarAba();}
  catch(err){pq.cats=null;pq.erro=err.message;desenharCats();desenharRes();}finally{if(vivo()){b.disabled=false;b.textContent='Buscar categorias';}}};
 setTimeout(()=>el.querySelector('#mk-termo')?.focus(),50);
 const $=s=>el.querySelector(s),alive=()=>Router.currentPage==='mercado-tiops'&&!!$('#tm-form');
 async function api(body){const r=await glrApiFetch('/api/tiops-market',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const j=await r.json();if(!r.ok)throw Error(j.error||'Falha na consulta.');return j;}
 function form(){const d=catalog.actions[$('#tm-action').value];$('#tm-desc').textContent=d.description;$('#tm-fields').innerHTML=Object.entries(d.schema.properties||{}).filter(([,p])=>['string','number','integer','boolean'].includes(p.type)).map(([k,p])=>`<label style="display:flex;flex-direction:column;gap:7px">${h(k)}${d.schema.required?.includes(k)?' *':''}<input class="form-control" name="${h(k)}" type="${['number','integer'].includes(p.type)?'number':'text'}" ${d.schema.required?.includes(k)?'required':''} maxlength="500" ${p.type==='number'?'step="any"':''} placeholder="${p.type==='boolean'?'true ou false':''}"><small style="font-size:11px;color:var(--text-muted)">${h(p.description||'')}</small></label>`).join('');$('#tm-results').innerHTML='';latest=null;$('#tm-status').textContent='';}
 function value(v,depth=0){if(v===null||v===undefined)return '<span style="opacity:.6">Não informado</span>';if(typeof v!=='object')return h(v);if(depth>5)return h(JSON.stringify(v));if(Array.isArray(v)){if(!v.length)return '<p>Nenhum resultado retornado.</p>';return v.slice(0,50).map((x,i)=>`<details style="padding:10px;border-bottom:1px solid var(--border)" ${i<3?'open':''}><summary>${h(x?.title||x?.name||x?.keyword||x?.id||`Resultado ${i+1}`)}</summary>${value(x,depth+1)}</details>`).join('')+(v.length>50?`<p>Exibindo 50 de ${v.length} resultados.</p>`:'');}return `<dl style="display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,3fr);gap:8px;font-size:13px;overflow-wrap:anywhere">${Object.entries(v).map(([k,x])=>`<dt style="color:var(--text-muted)">${h(k)}</dt><dd style="margin:0;min-width:0">${value(x,depth+1)}</dd>`).join('')}</dl>`;}
 $('#tm-form').onsubmit=async e=>{e.preventDefault();if(busy||!catalog)return;busy=true;$('#tm-run').disabled=true;$('#tm-action').disabled=true;$('#tm-status').textContent='Consultando o Tiops…';$('#tm-results').innerHTML='';latest=null;try{const action=$('#tm-action').value,d=catalog.actions[action],p={};for(const [k,v]of new FormData($('#tm-form'))){if(!v.trim())continue;const type=d.schema.properties[k].type;p[k]=['number','integer'].includes(type)?Number(v):type==='boolean'?v==='true'?true:v==='false'?false:v:v.trim();}const j=await api({action,params:p,contas:contasML()});if(!alive())return;latest=j;$('#tm-status').textContent=`Fonte: Tiops / Mercado Livre · ${new Date(j.consultado_em).toLocaleString('pt-BR')} · ${action}`;$('#tm-results').innerHTML=value(j.resposta.data??j.resposta);}catch(e){if(alive())$('#tm-status').textContent=e.message;}finally{busy=false;if(alive()){$('#tm-run').disabled=false;$('#tm-action').disabled=false;}}};
 $('#tm-discover').onclick=async()=>{if(busy)return;busy=true;$('#tm-discover').disabled=true;$('#tm-discovery').textContent='Verificando catálogo da sua conexão…';try{const j=await api({acao:'descobrir'});if(!alive())return;const enabled=Object.keys(catalog.actions),pending=j.acoes_na_conexao.filter(n=>!enabled.includes(n));$('#tm-discovery').innerHTML=`<b>${j.total_na_conexao} ações informadas pelo Tiops</b><p>${enabled.length} consultas de mercado habilitadas nesta tela. Outros recursos encontrados para revisão:</p><p style="overflow-wrap:anywhere;font-size:12px">${pending.map(h).join(' · ')||'Nenhum adicional nesta busca.'}</p><small>Novidades encontradas não são ativadas automaticamente. Monitoramento periódico, avaliações e dados de vendas dependem de suporte específico do provedor.</small>`;}catch(e){if(alive())$('#tm-discovery').textContent=e.message;}finally{busy=false;if(alive())$('#tm-discover').disabled=false;}};
 $('#tm-chat').onclick=()=>Router.navigate('chat');
 try{catalog=await api();if(!alive())return;$('#tm-action').innerHTML=Object.keys(catalog.actions).sort((a,b)=>Object.keys(names).indexOf(a)-Object.keys(names).indexOf(b)).map(n=>`<option value="${h(n)}">${h(names[n]||n)}</option>`).join('');$('#tm-action').onchange=form;form();$('#tm-run').disabled=false;}catch(e){if(alive())$('#tm-status').textContent=e.message;}
});
