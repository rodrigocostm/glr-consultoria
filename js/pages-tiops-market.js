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
  <header class="mk-cab">
   <div><span class="mk-eyebrow">Preço e concorrência · Mercado Livre</span><h2>Mercado e concorrência</h2>
    <p>Cole o link de um concorrente para ver preço, vendas, reputação e qualidade do anúncio — ou compare vários lado a lado.</p></div>
   <button class="btn btn-ghost btn-sm" id="tm-chat" title="Peça uma análise em linguagem natural">Perguntar aos agentes →</button>
  </header>
  <nav class="mk-modos" role="tablist" aria-label="Tipo de pesquisa">
   <button type="button" role="tab" class="on" data-modo="link" aria-selected="true">Concorrência por link</button>
   <button type="button" role="tab" data-modo="cat" aria-selected="false">Pesquisar categoria</button>
  </nav>
  <section id="mk-pane-link" class="mk-pane">
   <form class="mk-busca card" id="mk-lform" autocomplete="off">
    <label for="mk-l0">Link do anúncio</label>
    <div id="mk-links" class="mk-links"></div>
    <div class="mk-lacoes"><button type="button" class="mk-mais" id="mk-mais">+ Comparar com outro link</button><span class="mk-sub">Até 4 anúncios. Dica: coloque o anúncio do cliente primeiro.</span>
     <button class="btn btn-primary" id="mk-analisar">Analisar</button></div>
   </form>
   <div id="mk-lres"></div>
   <div id="mk-lider"></div>
  </section>
  <section id="mk-pane-cat" class="mk-pane" hidden>
   <form class="mk-busca card" id="mk-form" autocomplete="off">
    <label for="mk-termo">Produto ou categoria</label>
    <div class="mk-linha" id="mk-linha"><input id="mk-termo" class="form-control" placeholder="Ex.: armário aéreo, rack para TV, cadeira gamer…" maxlength="120"><button class="btn btn-primary" id="mk-buscar">Buscar categorias</button></div>
    <div id="mk-cats" class="mk-cats"></div>
   </form>
   <div id="mk-res"></div>
  </section>
  <details class="mk-avancado card"><summary>Consulta avançada (direto no Tiops)</summary>
   <div id="tm-discovery" style="margin:10px 0"></div><button class="btn btn-secondary btn-sm" id="tm-discover" type="button">Verificar novidades na conexão</button>
   <form id="tm-form" style="margin-top:16px"><label for="tm-action">Consulta</label><select id="tm-action" class="form-control" style="width:100%;margin:8px 0 12px"><option>Carregando consultas…</option></select><p id="tm-desc" class="mk-sub"></p><div id="tm-fields" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:16px"></div><button id="tm-run" class="btn btn-primary btn-sm" style="margin-top:14px" disabled>Consultar</button></form>
   <p id="tm-status" role="status" aria-live="polite" class="mk-sub"></p><div id="tm-results"></div></details>
 </div>
 <style>
  .mk{display:flex;flex-direction:column;gap:16px;max-width:1160px}
  .mk-cab{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
  .mk-eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);font-weight:700}
  .mk-cab h2{margin:2px 0 0;font-size:22px;letter-spacing:-.01em} .mk-cab p{margin:4px 0 0;color:var(--text-muted);font-size:13.5px;max-width:640px;line-height:1.5}
  .mk-modos{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card);align-self:flex-start}
  .mk-modos button{border:0;background:transparent;color:var(--text-secondary);border-radius:9px;padding:8px 16px;font:600 13px/1 inherit;font-family:inherit;cursor:pointer}
  .mk-modos button.on{background:var(--accent);color:#fff} .mk-modos button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .mk-pane{display:flex;flex-direction:column;gap:16px} .mk-pane[hidden]{display:none}
  .mk-busca{padding:18px} .mk-busca label{font-size:12.5px;font-weight:600;color:var(--text-secondary)}
  .mk-links{display:flex;flex-direction:column;gap:8px;margin-top:6px}
  .mk-lin{display:flex;gap:8px;align-items:center} .mk-lin input{flex:1;font-size:14.5px}
  .mk-lin .mk-n{width:22px;height:22px;flex:none;border-radius:50%;background:var(--bg-subtle);color:var(--text-secondary);font-size:11.5px;font-weight:700;display:flex;align-items:center;justify-content:center}
  .mk-x{all:unset;cursor:pointer;color:var(--text-muted);font-size:18px;padding:0 6px} .mk-x:hover{color:var(--red)} .mk-x:focus-visible{outline:2px solid var(--accent)}
  .mk-lacoes{display:flex;gap:12px;align-items:center;margin-top:12px;flex-wrap:wrap} .mk-lacoes .btn{margin-left:auto}
  .mk-mais{all:unset;cursor:pointer;color:var(--accent);font-size:13px;font-weight:600} .mk-mais:focus-visible{outline:2px solid var(--accent)} .mk-mais[disabled]{opacity:.4;cursor:default}
  .mk-linha{display:flex;gap:8px;margin-top:6px} .mk-linha input{flex:1;font-size:15px}
  .mk-cats{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px} .mk-cats:empty{display:none}
  .mk-cat{all:unset;cursor:pointer;display:flex;flex-direction:column;padding:7px 12px;border:1px solid var(--border);border-radius:10px;font-size:13px;color:var(--text-primary)} .mk-cat small{font-size:11px;color:var(--text-muted)}
  .mk-cat:hover{border-color:var(--accent)} .mk-cat.on{border-color:var(--accent);background:var(--accent-glow)} .mk-cat:focus-visible{outline:2px solid var(--accent)}
  .mk-sub{font-size:12.5px;color:var(--text-muted)} .mk-erro{color:var(--red);font-size:13px;padding:12px 2px}
  .mk-abas{display:flex;gap:4px;margin-bottom:12px} .mk-abas button{border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);border-radius:99px;padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit} .mk-abas button.on{border-color:var(--accent);background:var(--accent-glow);color:var(--text-primary);font-weight:600}
  .mk-grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
  .mk-item{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card);text-decoration:none;color:var(--text-primary);position:relative;transition:border-color .15s,transform .15s} .mk-item:hover{border-color:var(--accent);transform:translateY(-1px)}
  .mk-item img{width:100%;aspect-ratio:1;object-fit:contain;background:#fff;border-radius:8px} .mk-ph{width:100%;aspect-ratio:1;border-radius:8px;background:var(--bg-subtle);display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-muted)}
  .mk-pos{position:absolute;top:8px;left:8px;background:var(--text-primary);color:var(--bg-base);font-size:11px;font-weight:700;border-radius:6px;padding:1px 7px}
  .mk-item b{font-size:12.5px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden} .mk-item small{font-size:11px;color:var(--text-muted)}
  .mk-termos{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px} .mk-col h4{margin:0 0 6px;font-size:13px} .mk-col ol{margin:0;padding-left:20px;font-size:13px;line-height:1.8} .mk-col a{color:var(--text-primary)}
  .mk-avancado{padding:14px 18px} .mk-avancado summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--text-secondary)}
  .mk-carr{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px} .mk-carr span{aspect-ratio:1;border-radius:12px;background:var(--bg-subtle);animation:mkp 1.2s infinite alternate} @keyframes mkp{to{opacity:.5}}
  /* ficha de um anúncio */
  .mk-ad{display:grid;grid-template-columns:minmax(220px,320px) 1fr;gap:22px;padding:20px}
  .mk-gal{display:flex;flex-direction:column;gap:8px} .mk-gal .mk-foto{width:100%;aspect-ratio:1;object-fit:contain;background:#fff;border-radius:12px;border:1px solid var(--border)}
  .mk-th{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px} .mk-th button{all:unset;cursor:pointer;flex:none;width:52px;height:52px;border-radius:8px;border:1px solid var(--border);background:#fff;overflow:hidden} .mk-th button.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)} .mk-th img{width:100%;height:100%;object-fit:contain}
  .mk-ad h3{margin:0;font-size:17px;line-height:1.35;text-wrap:balance}
  .mk-preco{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:10px 0 4px} .mk-preco b{font-size:28px;letter-spacing:-.02em;font-variant-numeric:tabular-nums} .mk-preco s{color:var(--text-muted);font-size:14px} .mk-off{font-size:12px;font-weight:700;color:var(--green);background:color-mix(in srgb,var(--green) 12%,transparent);border-radius:6px;padding:2px 7px}
  .mk-meta{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--text-secondary);margin:6px 0 14px} .mk-meta b{color:var(--text-primary)}
  .mk-vend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 14px;border-radius:12px;background:var(--bg-subtle);font-size:13px}
  .mk-vend a{color:var(--text-primary);font-weight:700}
  .mk-term{display:inline-flex;gap:2px} .mk-term i{width:16px;height:6px;border-radius:2px;background:var(--border)}
  .mk-term[data-n="1"] i:nth-child(1){background:#e5484d} .mk-term[data-n="2"] i:nth-child(-n+2){background:#f76b15} .mk-term[data-n="3"] i:nth-child(-n+3){background:#f5d90a} .mk-term[data-n="4"] i:nth-child(-n+4){background:#99d52a} .mk-term[data-n="5"] i{background:#30a46c}
  .mk-chk{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-top:14px}
  .mk-chk div{border:1px solid var(--border);border-radius:10px;padding:9px 11px;font-size:12.5px;color:var(--text-secondary)} .mk-chk div b{display:block;font-size:15px;color:var(--text-primary);font-variant-numeric:tabular-nums}
  .mk-chk div.ok{border-color:color-mix(in srgb,var(--green) 45%,var(--border))} .mk-chk div.ruim{border-color:color-mix(in srgb,var(--yellow) 60%,var(--border))}
  .mk-chk div.ok b::after{content:' ✓';color:var(--green);font-size:12px} .mk-chk div.ruim b::after{content:' !';color:var(--yellow);font-size:12px}
  .mk-ad details{margin-top:12px;font-size:13px} .mk-ad summary{cursor:pointer;font-weight:600;color:var(--text-secondary)}
  .mk-ficha{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:4px 16px;margin-top:8px} .mk-ficha span{color:var(--text-muted)}
  .mk-desc{white-space:pre-line;color:var(--text-secondary);line-height:1.55;margin-top:8px}
  /* comparação */
  .mk-cmp-wrap{overflow-x:auto;padding:6px 4px 4px} .mk-cmp{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;min-width:560px}
  .mk-cmp th,.mk-cmp td{padding:9px 12px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top} .mk-cmp tbody th{color:var(--text-muted);font-weight:600;white-space:nowrap;width:150px}
  .mk-cmp thead td{vertical-align:bottom} .mk-cmp thead img{width:84px;height:84px;object-fit:contain;background:#fff;border-radius:10px;border:1px solid var(--border);display:block;margin-bottom:6px}
  .mk-cmp thead a{color:var(--text-primary);font-weight:600;font-size:12.5px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .mk-cmp td{font-variant-numeric:tabular-nums} .mk-cmp td.top{font-weight:700;color:var(--text-primary)} .mk-cmp td.top::after{content:'melhor';margin-left:6px;font-size:10.5px;font-weight:700;color:var(--accent);background:var(--accent-glow);border-radius:5px;padding:1px 6px}
  .mk-cmp .mk-seu{font-size:10.5px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.06em}
  .mk-espera{padding:22px;display:flex;flex-direction:column;gap:10px} .mk-espera .mk-barra{height:4px;border-radius:2px;background:var(--bg-subtle);overflow:hidden} .mk-espera .mk-barra i{display:block;height:100%;width:40%;background:var(--accent);animation:mkb 1.4s ease-in-out infinite} @keyframes mkb{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
  @media (prefers-reduced-motion:reduce){.mk-carr span,.mk-espera .mk-barra i{animation:none}.mk-item:hover{transform:none}}
  @media (max-width:720px){.mk-ad{grid-template-columns:1fr}.mk-lacoes .btn{margin-left:0;width:100%}}
  @media (max-width:600px){.mk-linha{flex-direction:column}}
 </style>`;
 // ── modos (link × categoria) ──
 el.querySelectorAll('[data-modo]').forEach(b=>b.onclick=()=>{el.querySelectorAll('[data-modo]').forEach(x=>{x.classList.toggle('on',x===b);x.setAttribute('aria-selected',x===b);});
  el.querySelector('#mk-pane-link').hidden=b.dataset.modo!=='link';el.querySelector('#mk-pane-cat').hidden=b.dataset.modo!=='cat';
  setTimeout(()=>el.querySelector(b.dataset.modo==='link'?'#mk-l0':'#mk-termo')?.focus(),30);});
 // ── concorrência por link ──
 const lk={links:[''],busy:false,res:null,erro:''};
 const R$=v=>v==null?'—':Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
 const n0=v=>v==null?'—':Number(v).toLocaleString('pt-BR');
 const NIVEL={'1_red':1,'2_orange':2,'3_yellow':3,'4_light_green':4,'5_green':5};
 const MEDALHA={platinum:'MercadoLíder Platinum',gold:'MercadoLíder Gold',silver:'MercadoLíder'};
 const termometro=r=>{const n=NIVEL[r?.nivel]||0;return n?`<span class="mk-term" data-n="${n}" title="Reputação ${n} de 5">${'<i></i>'.repeat(5)}</span>`:'';};
 function desenharLinks(){const box=el.querySelector('#mk-links');
  box.innerHTML=lk.links.map((v,i)=>`<div class="mk-lin">${lk.links.length>1?`<span class="mk-n">${i+1}</span>`:''}<input id="mk-l${i}" class="form-control" data-i="${i}" value="${h(v)}" placeholder="${i?'Link de outro anúncio para comparar':'https://www.mercadolivre.com.br/… ou MLB1234567890'}" maxlength="800" inputmode="url">${lk.links.length>1?`<button type="button" class="mk-x" data-rm="${i}" aria-label="Remover link ${i+1}">×</button>`:''}</div>`).join('');
  box.querySelectorAll('input').forEach(x=>x.oninput=()=>{lk.links[+x.dataset.i]=x.value;});
  box.querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{lk.links.splice(+b.dataset.rm,1);desenharLinks();});
  const mais=el.querySelector('#mk-mais');mais.disabled=lk.links.length>=4;
  el.querySelector('#mk-analisar').textContent=lk.busy?'Analisando…':lk.links.filter(x=>x.trim()).length>1?'Comparar':'Analisar';}
 el.querySelector('#mk-mais').onclick=()=>{if(lk.links.length>=4)return;lk.links.push('');desenharLinks();el.querySelector(`#mk-l${lk.links.length-1}`)?.focus();};
 function checks(a){const c=(rot,val,ok,dica)=>`<div class="${ok==null?'':ok?'ok':'ruim'}" title="${h(dica)}"><b>${val}</b>${rot}</div>`;
  return `<div class="mk-chk">${[
   c('fotos',a.n_fotos,a.n_fotos>=6,'Anúncios que vendem bem costumam ter 6 fotos ou mais'),
   c('itens na ficha técnica',a.n_atributos,a.n_atributos>=15,'Ficha completa ajuda na busca e nos filtros'),
   c('caracteres na descrição',n0(a.tam_descricao),a.tam_descricao>=400,'Descrição com medidas, material e o que vem na caixa'),
   c('avaliações',a.avaliacoes==null?'—':n0(a.avaliacoes),a.avaliacoes==null?null:a.avaliacoes>=10,'Prova social: quantas pessoas avaliaram'),
  ].join('')}</div>`;}
 function fichaAnuncio(a){
  const fotos=a.fotos.length?`<img class="mk-foto" id="mk-foto" src="${h(a.fotos[0])}" alt="Foto do anúncio">${a.fotos.length>1?`<div class="mk-th">${a.fotos.map((f,i)=>`<button type="button" class="${i?'':'on'}" data-foto="${h(f)}" aria-label="Foto ${i+1}"><img src="${h(f)}" alt="" loading="lazy"></button>`).join('')}</div>`:''}`:'<div class="mk-ph">sem foto</div>';
  const ficha=Object.entries(a.ficha||{});
  return `<article class="card mk-ad"><div class="mk-gal">${fotos}</div><div>
   <h3>${h(a.titulo)}</h3>
   <div class="mk-preco"><b>${R$(a.preco)}</b>${a.preco_original?`<s>${R$(a.preco_original)}</s>`:''}${a.desconto?`<span class="mk-off">${a.desconto}% OFF</span>`:''}</div>
   <div class="mk-meta"><span><b>${h(a.vendidos_txt||'—')}</b></span>${a.nota!=null?`<span><b>${String(a.nota).replace('.',',')}★</b> (${n0(a.avaliacoes)} avaliações)</span>`:'<span>Sem avaliações</span>'}${a.condicao?`<span>${h(a.condicao)}</span>`:''}<span>${h(a.id||'')}</span></div>
   <div class="mk-vend">${termometro(a.reputacao)}<span>Vendedor ${a.vendedor_url?`<a href="${h(a.vendedor_url)}" target="_blank" rel="noopener">${h(a.vendedor||'—')}</a>`:`<b>${h(a.vendedor||'—')}</b>`}</span>${a.reputacao?.medalha?`<span>${h(MEDALHA[a.reputacao.medalha]||a.reputacao.medalha)}</span>`:''}${a.reputacao?.vendas_totais!=null?`<span><b>${n0(a.reputacao.vendas_totais)}</b> vendas no total</span>`:''}${a.loja_oficial?'<span>Loja oficial</span>':''}</div>
   ${checks(a)}
   ${ficha.length?`<details><summary>Ficha técnica (${ficha.length})</summary><div class="mk-ficha">${ficha.map(([k,v])=>`<div><span>${h(k)}:</span> ${h(v)}</div>`).join('')}</div></details>`:''}
   ${a.descricao?`<details><summary>Descrição</summary><div class="mk-desc">${h(a.descricao)}${a.tam_descricao>600?'…':''}</div></details>`:''}
   <p style="margin:14px 0 0"><a class="btn btn-secondary btn-sm" href="${h(a.link)}" target="_blank" rel="noopener">Abrir no Mercado Livre ↗</a></p>
  </div></article>`;}
 function comparacao(as){
  const ok=as.filter(a=>!a.erro);
  const melhor=(get,menor)=>{const v=ok.map(get).filter(x=>x!=null);if(v.length<2)return null;return menor?Math.min(...v):Math.max(...v);};
  const linha=(rot,get,fmt,menor)=>{const m=melhor(get,menor);return `<tr><th scope="row">${rot}</th>${as.map(a=>{if(a.erro)return '<td>—</td>';const v=get(a);return `<td class="${m!=null&&v===m&&ok.filter(x=>get(x)===m).length===1?'top':''}">${v==null?'—':fmt(v,a)}</td>`;}).join('')}</tr>`;};
  const barato=melhor(a=>a.preco,true);
  return `<div class="card" style="padding:16px 14px"><div class="mk-cmp-wrap"><table class="mk-cmp"><thead><tr><td></td>${as.map((a,i)=>`<td>${i===0?'<div class="mk-seu">Referência</div>':''}${a.erro?`<div class="mk-erro" style="padding:0">${h(a.erro)}</div><small class="mk-sub" style="overflow-wrap:anywhere">${h(a.link)}</small>`:`${a.fotos[0]?`<img src="${h(a.fotos[0])}" alt="" loading="lazy">`:''}<a href="${h(a.link)}" target="_blank" rel="noopener">${h(a.titulo)}</a>`}</td>`).join('')}</tr></thead><tbody>
   ${linha('Preço',a=>a.preco,v=>`<b>${R$(v)}</b>`,true)}
   ${barato!=null?`<tr><th scope="row">vs. mais barato</th>${as.map(a=>`<td>${a.erro||a.preco==null?'—':a.preco===barato?'o mais barato':`+${Math.round((a.preco/barato-1)*100)}% (${R$(a.preco-barato)})`}</td>`).join('')}</tr>`:''}
   ${linha('Desconto',a=>a.desconto,v=>`${v}% OFF`)}
   ${linha('Vendidos',a=>a.vendidos,(v,a)=>h(a.vendidos_txt||n0(v)))}
   ${linha('Nota',a=>a.nota,v=>`${String(v).replace('.',',')}★`)}
   ${linha('Avaliações',a=>a.avaliacoes,v=>n0(v))}
   <tr><th scope="row">Vendedor</th>${as.map(a=>`<td>${a.erro?'—':`${termometro(a.reputacao)}<div>${h(a.vendedor||'—')}</div>${a.reputacao?.medalha?`<small class="mk-sub">${h(MEDALHA[a.reputacao.medalha]||a.reputacao.medalha)}</small>`:''}`}</td>`).join('')}</tr>
   ${linha('Vendas do vendedor',a=>a.reputacao?.vendas_totais??null,v=>n0(v))}
   ${linha('Fotos',a=>a.n_fotos,v=>n0(v))}
   ${linha('Itens na ficha',a=>a.n_atributos,v=>n0(v))}
   ${linha('Descrição',a=>a.tam_descricao,v=>`${n0(v)} caract.`)}
  </tbody></table></div>
  <p class="mk-sub" style="margin:10px 8px 0">"Vendidos" é o texto que o Mercado Livre mostra na página (arredondado). Visitas e vendas por período são dados privados de cada vendedor.</p></div>`;}
 function desenharLRes(){const box=el.querySelector('#mk-lres');
  if(lk.busy){const n=lk.links.filter(x=>x.trim()).length;box.innerHTML=`<div class="card mk-espera" role="status"><b>Lendo ${n>1?`${n} anúncios`:'o anúncio'} no Mercado Livre…</b><span class="mk-sub">${n>1?`Um anúncio por vez — cerca de ${n*20} a ${n*35} segundos.`:'Leva de 15 a 40 segundos.'}</span><div class="mk-barra"><i></i></div></div>`;return;}
  if(lk.erro){box.innerHTML=`<div class="card" style="padding:16px"><div class="mk-erro" style="padding:0">${h(lk.erro)}</div></div>`;return;}
  if(!lk.res){box.innerHTML='';return;}
  const as=lk.res.anuncios;
  box.innerHTML=(as.length>1?comparacao(as):'')+as.filter(a=>!a.erro).map((a,i)=>as.length>1?`<details class="card" style="padding:0"${i?'':''}><summary style="padding:14px 18px;cursor:pointer;font-weight:600;font-size:13px">Detalhes — ${h(String(a.titulo).slice(0,80))}</summary>${fichaAnuncio(a)}</details>`:fichaAnuncio(a)).join('')+`<p class="mk-sub">Fonte: Mercado Livre via Tiops · ${new Date(lk.res.em).toLocaleString('pt-BR')}</p>`;
  box.querySelectorAll('.mk-ad').forEach(ad=>ad.querySelectorAll('[data-foto]').forEach(b=>b.onclick=()=>{ad.querySelector('.mk-foto').src=b.dataset.foto;ad.querySelectorAll('[data-foto]').forEach(x=>x.classList.toggle('on',x===b));}));}
 el.querySelector('#mk-lform').onsubmit=async e=>{e.preventDefault();if(lk.busy)return;
  const links=lk.links.map(x=>x.trim()).filter(Boolean);if(!links.length){el.querySelector('#mk-l0')?.focus();return;}
  lk.busy=true;lk.erro='';lk.res=null;lk.lideres=null;desenharLinks();desenharLRes();desenharLideres();
  try{const r=await pesquisa(links.length>1?'comparar':'link',{links});if(!vivo())return;lk.res=r;}
  catch(err){lk.erro=err.message;}finally{lk.busy=false;if(vivo()){desenharLinks();desenharLRes();}}
  const ref=lk.res?.anuncios?.find(a=>!a.erro);
  if(ref&&vivo()){lk.lideres={busy:true};desenharLideres();
   try{const r=await pesquisa('lideres',{titulo:ref.titulo});if(!vivo())return;lk.lideres=r;}catch(err){lk.lideres={erro:err.message};}
   if(vivo())desenharLideres();}};
 function desenharLideres(){const box=el.querySelector('#mk-lider');if(!box)return;const L=lk.lideres,ref=lk.res?.anuncios?.find(a=>!a.erro);
  if(!L){box.innerHTML='';return;}
  if(L.busy){box.innerHTML=`<div class="card mk-espera" role="status"><b>Buscando a concorrência na categoria…</b><div class="mk-barra"><i></i></div></div>`;return;}
  if(L.erro){box.innerHTML=`<div class="card" style="padding:16px"><b>Concorrência na categoria</b><div class="mk-erro" style="padding:6px 0 0">${h(L.erro)}</div></div>`;return;}
  if(!L.categoria||!L.itens?.length){box.innerHTML=`<div class="card" style="padding:16px"><b>Concorrência na categoria</b><p class="mk-sub">O Mercado Livre não retornou os mais vendidos desta categoria.</p></div>`;return;}
  const precos=L.itens.map(x=>x.preco).filter(v=>v!=null).sort((a,b)=>a-b);
  const med=precos.length?precos[Math.floor(precos.length/2)]:null;
  const posRef=ref&&L.itens.find(x=>x.id===ref.id||(ref.link||'').includes(x.id));
  const dif=ref?.preco!=null&&med?Math.round((ref.preco/med-1)*100):null;
  const resumo=med?`<div class="mk-chk" style="margin:0 0 14px">
    <div><b>${R$(med)}</b>preço mediano dos líderes</div>
    <div><b>${R$(precos[0])} – ${R$(precos[precos.length-1])}</b>faixa de preço (${precos.length} com preço)</div>
    ${ref?.preco!=null?`<div class="${dif>15?'ruim':dif<-15?'':'ok'}"><b>${dif>0?'+':''}${dif}%</b>anúncio analisado vs. mediana</div>`:''}
    <div class="${posRef?'ok':''}"><b>${posRef?`${posRef.pos}º`:'fora do top 20'}</b>posição do anúncio analisado</div></div>`:'';
  box.innerHTML=`<div class="card" style="padding:18px"><div class="mk-cab" style="margin-bottom:12px"><div><span class="mk-eyebrow">Concorrência</span><h2 style="font-size:16px">Mais vendidos em ${h(L.categoria.nome)}</h2><p>Os 20 anúncios que mais vendem na categoria do anúncio analisado, pelo ranking do Mercado Livre.</p></div></div>
   ${resumo}
   <div class="mk-grade">${L.itens.map(x=>`<a class="mk-item" href="${h(x.link)}" target="_blank" rel="noopener"${posRef&&x.id===posRef.id?' style="border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)"':''}><span class="mk-pos">${x.pos}º</span>${x.foto?`<img src="${h(x.foto)}" alt="" loading="lazy">`:`<span class="mk-ph">${x.tipo==='PRODUCT'?'catálogo':'anúncio'}</span>`}<b>${h(x.nome||(x.tipo==='PRODUCT'?'Produto de catálogo':'Anúncio de vendedor'))}</b>${x.preco!=null?`<span style="font-weight:700;font-variant-numeric:tabular-nums">${R$(x.preco)}${ref?.preco!=null?` <small style="color:${x.preco<ref.preco?'var(--red)':'var(--green)'}">${x.preco<ref.preco?'mais barato':'mais caro'}</small>`:''}</span>`:''}<small>${h(x.marca?x.marca+' · ':'')}${x.full?'Full · ':''}abrir no ML ↗</small></a>`).join('')}</div>
   <p class="mk-sub">Preço = vencedor do catálogo quando o ML informa. Anúncios fora de catálogo não mostram nome nem preço pela API — cole o link deles acima para analisar.</p></div>`;}
 desenharLinks();
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
 setTimeout(()=>el.querySelector('#mk-l0')?.focus(),50);
 const $=s=>el.querySelector(s),alive=()=>Router.currentPage==='mercado-tiops'&&!!$('#tm-form');
 async function api(body){const r=await glrApiFetch('/api/tiops-market',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const j=await r.json();if(!r.ok)throw Error(j.error||'Falha na consulta.');return j;}
 function form(){const d=catalog.actions[$('#tm-action').value];$('#tm-desc').textContent=d.description;$('#tm-fields').innerHTML=Object.entries(d.schema.properties||{}).filter(([,p])=>['string','number','integer','boolean'].includes(p.type)).map(([k,p])=>`<label style="display:flex;flex-direction:column;gap:7px">${h(k)}${d.schema.required?.includes(k)?' *':''}<input class="form-control" name="${h(k)}" type="${['number','integer'].includes(p.type)?'number':'text'}" ${d.schema.required?.includes(k)?'required':''} maxlength="500" ${p.type==='number'?'step="any"':''} placeholder="${p.type==='boolean'?'true ou false':''}"><small style="font-size:11px;color:var(--text-muted)">${h(p.description||'')}</small></label>`).join('');$('#tm-results').innerHTML='';latest=null;$('#tm-status').textContent='';}
 function value(v,depth=0){if(v===null||v===undefined)return '<span style="opacity:.6">Não informado</span>';if(typeof v!=='object')return h(v);if(depth>5)return h(JSON.stringify(v));if(Array.isArray(v)){if(!v.length)return '<p>Nenhum resultado retornado.</p>';return v.slice(0,50).map((x,i)=>`<details style="padding:10px;border-bottom:1px solid var(--border)" ${i<3?'open':''}><summary>${h(x?.title||x?.name||x?.keyword||x?.id||`Resultado ${i+1}`)}</summary>${value(x,depth+1)}</details>`).join('')+(v.length>50?`<p>Exibindo 50 de ${v.length} resultados.</p>`:'');}return `<dl style="display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,3fr);gap:8px;font-size:13px;overflow-wrap:anywhere">${Object.entries(v).map(([k,x])=>`<dt style="color:var(--text-muted)">${h(k)}</dt><dd style="margin:0;min-width:0">${value(x,depth+1)}</dd>`).join('')}</dl>`;}
 $('#tm-form').onsubmit=async e=>{e.preventDefault();if(busy||!catalog)return;busy=true;$('#tm-run').disabled=true;$('#tm-action').disabled=true;$('#tm-status').textContent='Consultando o Tiops…';$('#tm-results').innerHTML='';latest=null;try{const action=$('#tm-action').value,d=catalog.actions[action],p={};for(const [k,v]of new FormData($('#tm-form'))){if(!v.trim())continue;const type=d.schema.properties[k].type;p[k]=['number','integer'].includes(type)?Number(v):type==='boolean'?v==='true'?true:v==='false'?false:v:v.trim();}const j=await api({action,params:p,contas:contasML()});if(!alive())return;latest=j;$('#tm-status').textContent=`Fonte: Tiops / Mercado Livre · ${new Date(j.consultado_em).toLocaleString('pt-BR')} · ${action}`;$('#tm-results').innerHTML=value(j.resposta.data??j.resposta);}catch(e){if(alive())$('#tm-status').textContent=e.message;}finally{busy=false;if(alive()){$('#tm-run').disabled=false;$('#tm-action').disabled=false;}}};
 $('#tm-discover').onclick=async()=>{if(busy)return;busy=true;$('#tm-discover').disabled=true;$('#tm-discovery').textContent='Verificando catálogo da sua conexão…';try{const j=await api({acao:'descobrir'});if(!alive())return;const enabled=Object.keys(catalog.actions),pending=j.acoes_na_conexao.filter(n=>!enabled.includes(n));$('#tm-discovery').innerHTML=`<b>${j.total_na_conexao} ações informadas pelo Tiops</b><p>${enabled.length} consultas de mercado habilitadas nesta tela. Outros recursos encontrados para revisão:</p><p style="overflow-wrap:anywhere;font-size:12px">${pending.map(h).join(' · ')||'Nenhum adicional nesta busca.'}</p><small>Novidades encontradas não são ativadas automaticamente. Monitoramento periódico, avaliações e dados de vendas dependem de suporte específico do provedor.</small>`;}catch(e){if(alive())$('#tm-discovery').textContent=e.message;}finally{busy=false;if(alive())$('#tm-discover').disabled=false;}};
 $('#tm-chat').onclick=()=>Router.navigate('chat');
 try{catalog=await api();if(!alive())return;$('#tm-action').innerHTML=Object.keys(catalog.actions).sort((a,b)=>Object.keys(names).indexOf(a)-Object.keys(names).indexOf(b)).map(n=>`<option value="${h(n)}">${h(names[n]||n)}</option>`).join('');$('#tm-action').onchange=form;form();$('#tm-run').disabled=false;}catch(e){if(alive())$('#tm-status').textContent=e.message;}
});
