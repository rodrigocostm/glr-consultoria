// ============================================================
// GLR Consultoria — Integração Supabase
// Substitui localStorage por banco na nuvem com autenticação
// ============================================================

const SUPABASE_URL = 'https://rrodqlejqyaoomutriiw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJyb2RxbGVqcXlhb29tdXRyaWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NjU5NjUsImV4cCI6MjA5NjQ0MTk2NX0.JaKQHoGH8S3ZdLQInLErpC21SZ0j4FmIGtvWKcBes-A';

// Cliente Supabase global
const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

// Chaves gerenciadas pelo sistema
const GLR_KEYS = [
  'glr_clientes', 'glr_gestores', 'glr_tarefas', 'glr_acoes',
  'glr_alertas', 'glr_oportunidades', 'glr_projecoes', 'glr_dre',
  'glr_mc_vinculos', 'glr_mc_nicknames', 'glr_portal_configs',
  'glr_vendas_custos',  // custo de produto lançado no admin — precisa chegar no portal do cliente
  'glr_vendas_custo_catalogo', // custo unitário fixo por produto (SKU/itemId) — aplica a pedidos antigos e novos
  'glr_aliquotas',      // % de imposto padrão por conta
  'glr_vendas_linhas',  // linhas extras de custo/desconto lançadas no admin
  'glr_mc_apikey',      // API Key do Marketplace Connect — precisa funcionar em qualquer PC do admin
  'glr_vendas_cache',   // pedidos já buscados na página Vendas — evita rebuscar em outro PC
  'glr_fin_cache',      // pedidos + ADS já buscados no Financeiro — evita rebuscar em outro PC
  'glr_mc_contas',      // lista de contas conectadas do Marketplace Connect
  'glr_analytics_dados', // painel executivo Analytics — meta/projeção/ADS por cliente (cache do mês)
  'glr_analytics_queda', // produtos em queda detectados pelo Analytics
  'glr_plano_acao',      // plano de ação (Analytics) — editorial, não vem de API
  'glr_checklist_diario', // checklist diário (Analytics) — editorial, não vem de API
  'glr_logs',            // log de alterações (auditoria) — quem mudou o quê
];

// ── Intercepta localStorage.setItem para sincronizar com Supabase ──
// Toda vez que qualquer parte do sistema salva no localStorage,
// automaticamente também salva no Supabase — sem alterar nenhum outro arquivo.
const _localSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = function(key, value) {
  _localSetItem(key, value); // salva local normalmente
  if (GLR_KEYS.includes(key)) {
    // Nem todo valor salvo é JSON (ex: glr_mc_apikey é uma string simples,
    // não "aspas-envolvida") — se JSON.parse falhar, sobe o valor cru mesmo
    let dados;
    try { dados = JSON.parse(value); } catch(e) { dados = value; }
    _sb.from('glr_storage')
      .upsert({ chave: key, dados, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' })
      .then(({ error }) => { if (error) console.warn('[Supabase] Erro sync:', error.message); });
  }
};

// Converte o valor vindo do Supabase de volta pro formato que o localStorage
// espera: string simples fica como está, objeto/array vira JSON.stringify
const _paraLocalStorage = dados => typeof dados === 'string' ? dados : JSON.stringify(dados);

// ── Carrega todos os dados do Supabase para o localStorage local ──
async function sincronizarDoSupabase() {
  const { data, error } = await _sb.from('glr_storage').select('chave, dados');
  if (error) { console.warn('[Supabase] Erro ao carregar:', error.message); return; }
  if (data?.length) {
    data.forEach(row => _localSetItem(row.chave, _paraLocalStorage(row.dados)));
    console.log(`[Supabase] ${data.length} coleções sincronizadas.`);
  }
  // Chaves que já existiam localmente mas nunca foram salvas desde que entraram no
  // GLR_KEYS (ex: dado antigo cadastrado antes do sync existir) — empurra pro Supabase
  // uma única vez, re-chamando o setItem interceptado.
  const chavesNoServidor = new Set((data||[]).map(r => r.chave));
  GLR_KEYS.forEach(key => {
    if (chavesNoServidor.has(key)) return;
    const local = localStorage.getItem(key);
    if (local != null) localStorage.setItem(key, local); // dispara o interceptor, empurra pro Supabase
  });
}

// ── Real-time: atualiza quando outro usuário salvar algo ──
function ativarRealtime() {
  _sb.channel('glr_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'glr_storage' }, payload => {
      if (payload.new?.chave && payload.new?.dados != null) {
        _localSetItem(payload.new.chave, _paraLocalStorage(payload.new.dados));
        if (typeof carregarDadosSalvos === 'function') carregarDadosSalvos();
        // Mostra notificação discreta
        mostrarNotifSync(payload.new.chave);
      }
    })
    .subscribe();
}

function mostrarNotifSync(chave) {
  const mapa = {
    glr_clientes: 'Clientes', glr_gestores: 'Gestores', glr_tarefas: 'Tarefas',
    glr_projecoes: 'Projeções', glr_dre: 'DRE', glr_alertas: 'Alertas',
  };
  const nome = mapa[chave];
  if (!nome) return;
  const notif = document.createElement('div');
  notif.style.cssText = `
    position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
    background:#16161f;border:1px solid rgba(99,102,241,0.3);border-radius:8px;
    padding:8px 16px;font-size:13px;color:#9192a8;z-index:9998;
    display:flex;align-items:center;gap:8px;box-shadow:0 4px 20px rgba(0,0,0,0.3);
    animation:fadeInUp 0.2s ease;
  `;
  notif.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:#10b981;flex-shrink:0;"></span> ${nome} atualizados por outro usuário`;
  document.body.appendChild(notif);
  setTimeout(() => notif.remove(), 3000);
}

// ── Página de Vendas (institucional, aparece antes do login) ──
const WHATSAPP_NUMERO = '5517992117263';

function mostrarVendas() {
  document.getElementById('glr-login-overlay')?.remove();
  document.getElementById('glr-vendas-overlay')?.remove();

  const params = new URLSearchParams(window.location.search);
  const utmSource = params.get('utm_source');
  const utmCampaign = params.get('utm_campaign');
  const waLink = msg => {
    const sufixo = utmSource ? ` (origem: ${utmSource}${utmCampaign ? ' / ' + utmCampaign : ''})` : '';
    return `https://wa.me/${WHATSAPP_NUMERO}?text=${encodeURIComponent(msg + sufixo)}`;
  };

  const overlay = document.createElement('div');
  overlay.id = 'glr-vendas-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;background:#0d0d14;z-index:9999;
    overflow-y:auto;font-family:'Inter',sans-serif;color:#f1f1f8;
  `;

  const dores = [
    { ico: '📉', texto: 'Verba de ADS queimando em anúncio mal configurado, sem ninguém revisando toda semana' },
    { ico: '🧾', texto: 'Taxa de marketplace que ninguém confere — e que raramente bate com o que devia' },
    { ico: '📦', texto: 'Catálogo desatualizado, com anúncio parado perdendo posição pra concorrência' },
    { ico: '🕐', texto: 'Você tentando tocar o operacional inteiro sozinho, sem tempo pra pensar em estratégia' },
    { ico: '📊', texto: 'Nenhuma visão financeira real — lucro líquido de verdade, não só faturamento bruto' },
    { ico: '❓', texto: 'Sem saber se está crescendo de verdade ou só girando o mesmo dinheiro' },
  ];

  const servicos = [
    { ico: '🏪', titulo: 'Abertura e configuração de contas', desc: 'Cuidamos de toda a abertura e configuração das suas contas nos marketplaces.' },
    { ico: '📦', titulo: 'Cadastro e otimização de produtos', desc: 'Anúncios cadastrados e otimizados pra vender mais dentro de cada plataforma.' },
    { ico: '📢', titulo: 'Gestão de ADS', desc: 'Campanhas acompanhadas e ajustadas continuamente pra não deixar verba queimando à toa.' },
    { ico: '💰', titulo: 'Financeiro e margem real', desc: 'DRE automático direto das taxas reais do marketplace — lucro líquido, não só faturamento.' },
    { ico: '🖥️', titulo: 'Sistema de gestão de produtos (ERP)', desc: 'ERP disponibilizado pra organizar estoque, catálogo e operação do dia a dia.' },
    { ico: '🎥', titulo: 'Orientação contínua', desc: 'Vídeos e conteúdos estratégicos pra aumentar suas vendas de forma consistente.' },
    { ico: '📅', titulo: '2 reuniões mensais', desc: 'Reuniões de análise de resultados e definição de estratégias, todo mês, com gente de verdade.' },
  ];

  const sistemaModulos = [
    { ico: '📊', titulo: 'Dashboard Executivo', desc: 'Visão consolidada da carteira, metas, crescimento e risco.' },
    { ico: '💰', titulo: 'Financeiro & DRE automático', desc: 'DRE calculado direto das taxas reais do Mercado Livre e Shopee.' },
    { ico: '📢', titulo: 'Central de ADS', desc: 'Investimento, ROAS e TACoS das campanhas em todas as contas.' },
    { ico: '✅', titulo: 'Conciliação Financeira', desc: 'Confere se a taxa calculada bate com o que a API descontou de fato.' },
    { ico: '🛒', titulo: 'Vendas & Oportunidades', desc: 'Pedidos, produtos parados e oportunidades de ADS.' },
    { ico: '🔐', titulo: 'Portal do Cliente', desc: 'Você acompanha suas próprias vendas e resultados com login próprio.' },
  ];

  const diferenciais = [
    { ico: '🤝', titulo: 'Acompanhamento humano', desc: 'Reuniões mensais reais, com gente que conhece sua conta — não um robô respondendo ticket.' },
    { ico: '🖥️', titulo: 'Sistema próprio', desc: 'O GLR Central foi construído internamente pra essa operação — não é uma ferramenta terceirizada genérica.' },
    { ico: '📊', titulo: 'Dado real, não estimado', desc: 'Financeiro calculado direto da API do marketplace, taxa por taxa — sem planilha aproximada.' },
    { ico: '🎯', titulo: 'Foco total em marketplace', desc: 'Não é uma agência genérica de marketing — é especializada em Mercado Livre, Shopee e Amazon.' },
  ];

  const depoimentos = [
    { nome: 'Cliente GLR', empresa: 'Loja de Eletrônicos' },
    { nome: 'Cliente GLR', empresa: 'Loja de Moda' },
    { nome: 'Cliente GLR', empresa: 'Loja de Casa & Decoração' },
  ];

  const faqs = [
    { q: 'Para quem é a GLR Consultoria?', a: 'Pra quem já vende (ou quer começar a vender) no Mercado Livre, Shopee ou Amazon e não tem tempo — ou time — pra acompanhar a operação todo dia.' },
    { q: 'Vocês cuidam da execução ou só dão o direcionamento?', a: 'Cuidamos da execução: cadastro de produto, gestão de ADS, acompanhamento financeiro. Você recebe direcionamento estratégico nas reuniões mensais, mas o operacional é feito pela equipe GLR.' },
    { q: 'Preciso ter uma equipe grande?', a: 'Não. Muitos dos nossos clientes tocam o negócio sozinhos ou com uma equipe pequena — é exatamente esse o problema que resolvemos.' },
    { q: 'Preciso ter CNPJ?', a: 'Pra vender nos principais marketplaces, sim — CNPJ é exigido pela maioria das plataformas. Se você ainda não tem, podemos te orientar sobre os próximos passos.' },
    { q: 'Quais marketplaces vocês gerenciam?', a: 'Mercado Livre, Shopee, Amazon e Magalu, com o sistema GLR Central acompanhando as contas em tempo real.' },
  ];

  const secaoCards = (icoTitDescArr) => icoTitDescArr.map(f => `
    <div style="background:#16161f;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:24px;">
      <div style="font-size:26px;margin-bottom:12px;">${f.ico}</div>
      <div style="font-size:15px;font-weight:700;margin-bottom:6px;">${f.titulo}</div>
      <div style="font-size:13px;color:#9192a8;line-height:1.5;">${f.desc}</div>
    </div>
  `).join('');

  overlay.innerHTML = `
    <div style="max-width:1080px;margin:0 auto;padding:24px 24px 0;">
      <div style="display:flex;align-items:center;padding:8px 0 32px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <img src="logo.png" alt="GLR" style="width:36px;height:36px;object-fit:contain;mix-blend-mode:screen;"
               onerror="this.style.display='none'">
          <strong style="font-size:16px;font-weight:800;">GLR Consultoria</strong>
        </div>
      </div>
    </div>

    <div style="max-width:780px;margin:0 auto;padding:24px 24px 64px;text-align:center;">
      <div style="display:inline-block;padding:6px 14px;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.3);border-radius:99px;font-size:12px;font-weight:600;color:#818cf8;margin-bottom:20px;">
        Consultoria em Marketplaces
      </div>
      <h1 style="font-size:38px;font-weight:800;line-height:1.15;margin:0 0 16px;letter-spacing:-0.5px;">
        Sua operação no Mercado Livre e Shopee, gerenciada por um time — não por você sozinho
      </h1>
      <p style="font-size:16px;color:#9192a8;line-height:1.6;margin:0 0 32px;">
        Cuidamos de anúncios, ADS, catálogo, financeiro e estratégia da sua loja, com reuniões mensais
        de verdade e um sistema próprio pra você acompanhar cada resultado em tempo real.
      </p>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
        <a href="${waLink('Olá! Quero saber mais sobre a consultoria da GLR.')}" target="_blank" rel="noopener"
          style="padding:14px 26px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;border-radius:10px;color:white;font-size:14px;font-weight:700;text-decoration:none;">
          💬 Falar com um especialista
        </a>
        <a href="#glr-sistema" style="padding:14px 26px;background:#16161f;border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#f1f1f8;font-size:14px;font-weight:700;text-decoration:none;">
          Ver como funciona
        </a>
      </div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:28px;">
        ${['🟡 Mercado Livre','🟠 Shopee','📦 Amazon','🔷 Magalu'].map(t => `
          <div style="padding:7px 14px;background:#1c1c28;border:1px solid rgba(255,255,255,0.08);border-radius:99px;font-size:12.5px;font-weight:600;color:#9192a8;">${t}</div>
        `).join('')}
      </div>
    </div>

    <div style="background:#16161f;border-top:1px solid rgba(255,255,255,0.06);border-bottom:1px solid rgba(255,255,255,0.06);padding:56px 24px;">
      <div style="max-width:900px;margin:0 auto;">
        <h2 style="text-align:center;font-size:24px;font-weight:800;margin:0 0 8px;">Gerenciar marketplace sozinho custa caro</h2>
        <p style="text-align:center;font-size:14px;color:#5a5b72;margin:0 0 36px;">Em tempo, em oportunidade e em dinheiro deixado na mesa.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;">
          ${dores.map(d => `
            <div style="background:#1c1c28;border:1px solid rgba(239,68,68,0.2);border-radius:14px;padding:18px;display:flex;gap:12px;align-items:flex-start;">
              <div style="font-size:18px;flex-shrink:0;">${d.ico}</div>
              <p style="font-size:13px;color:#9192a8;margin:0;">${d.texto}</p>
            </div>
          `).join('')}
        </div>
      </div>
    </div>

    <div style="max-width:1080px;margin:0 auto;padding:64px 24px;">
      <h2 style="text-align:center;font-size:24px;font-weight:800;margin:0 0 8px;">O que a consultoria oferece</h2>
      <p style="text-align:center;font-size:14px;color:#5a5b72;margin:0 0 36px;">Tudo incluso na parceria, do início da operação ao acompanhamento contínuo.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;">
        ${secaoCards(servicos)}
      </div>
    </div>

    <div id="glr-sistema" style="max-width:1080px;margin:0 auto;padding:0 24px 64px;">
      <h2 style="text-align:center;font-size:24px;font-weight:800;margin:0 0 8px;">O sistema que acompanha sua operação</h2>
      <p style="text-align:center;font-size:14px;color:#5a5b72;margin:0 0 36px;">Um dos serviços inclusos: o GLR Central, pra você e sua equipe acompanharem os resultados juntos.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;">
        ${secaoCards(sistemaModulos)}
      </div>
    </div>

    <div style="max-width:640px;margin:0 auto;padding:0 24px 64px;">
      <h2 style="text-align:center;font-size:24px;font-weight:800;margin:0 0 8px;">Investimento</h2>
      <p style="text-align:center;font-size:14px;color:#5a5b72;margin:0 0 36px;">Um modelo que acompanha o crescimento da sua operação.</p>
      <div style="background:#1c1c2e;border:1px solid #6366f1;border-radius:16px;padding:32px 28px;text-align:center;">
        <div style="font-size:32px;font-weight:800;margin-bottom:4px;">R$ 1.500<span style="font-size:16px;font-weight:600;color:#9192a8;">/mês</span></div>
        <div style="font-size:13px;color:#9192a8;margin-bottom:20px;">mensalidade fixa</div>
        <div style="height:1px;background:rgba(255,255,255,0.08);margin:0 0 20px;"></div>
        <p style="font-size:13px;color:#c7c8d8;line-height:1.6;margin:0 0 24px;">
          Quando R$ 3,00 por venda ultrapassar o valor da mensalidade fixa, a cobrança passa a ser
          <strong style="color:#f1f1f8;">R$ 3,00 por venda realizada</strong>, substituindo o valor fixo mensal —
          o investimento cresce junto com o seu faturamento.
        </p>
        <a href="${waLink('Olá! Quero saber mais sobre o investimento na consultoria da GLR.')}" target="_blank" rel="noopener"
          style="display:block;padding:13px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700;
                 background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;">
          Falar com um consultor
        </a>
      </div>
    </div>

    <div style="background:#16161f;border-top:1px solid rgba(255,255,255,0.06);border-bottom:1px solid rgba(255,255,255,0.06);padding:56px 24px;">
      <div style="max-width:1080px;margin:0 auto;">
        <h2 style="text-align:center;font-size:24px;font-weight:800;margin:0 0 8px;">Por que a GLR?</h2>
        <p style="text-align:center;font-size:14px;color:#5a5b72;margin:0 0 36px;">Consultoria de verdade — não terceirização remota sem rosto.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;">
          ${secaoCards(diferenciais)}
        </div>
      </div>
    </div>

    <div style="max-width:1080px;margin:0 auto;padding:64px 24px;">
      <h2 style="text-align:center;font-size:24px;font-weight:800;margin:0 0 36px;">O que nossos clientes dizem</h2>
      <p style="text-align:center;font-size:11px;color:#f59e0b;background:rgba(245,158,11,0.1);border:1px dashed rgba(245,158,11,0.4);border-radius:6px;padding:4px 10px;display:table;margin:-24px auto 28px;">
        ⚠️ Depoimentos reais em breve
      </p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;">
        ${depoimentos.map(d => `
          <div style="background:#16161f;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:22px;">
            <div style="font-size:13px;color:#c7c8d8;line-height:1.6;margin-bottom:16px;">"[Espaço reservado pra depoimento real]"</div>
            <div style="font-size:13px;font-weight:700;">${d.nome}</div>
            <div style="font-size:12px;color:#5a5b72;">${d.empresa}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <div style="max-width:760px;margin:0 auto;padding:0 24px 64px;">
      <h2 style="text-align:center;font-size:24px;font-weight:800;margin:0 0 36px;">Dúvidas frequentes</h2>
      <div id="glr-faq-list">
        ${faqs.map((f, i) => `
          <div class="glr-faq-item" style="border-bottom:1px solid rgba(255,255,255,0.08);">
            <div class="glr-faq-q" data-i="${i}" style="padding:18px 4px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-size:14px;font-weight:600;">
              ${f.q} <span style="font-size:19px;color:#6366f1;flex-shrink:0;margin-left:16px;">+</span>
            </div>
            <div class="glr-faq-a" style="max-height:0;overflow:hidden;transition:max-height .25s ease;font-size:13px;color:#9192a8;line-height:1.6;">
              <div style="padding-bottom:18px;">${f.a}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <div style="background:linear-gradient(135deg,rgba(99,102,241,0.12),rgba(139,92,246,0.08));border-top:1px solid rgba(255,255,255,0.06);padding:56px 24px;text-align:center;">
      <h2 style="font-size:24px;font-weight:800;margin:0 0 12px;">Pronto para organizar sua operação?</h2>
      <p style="font-size:14px;color:#9192a8;margin:0 0 24px;">Fale com a gente e veja o sistema funcionando na prática.</p>
      <a href="${waLink('Olá! Quero saber mais sobre o GLR Consultoria.')}" target="_blank" rel="noopener"
        style="display:inline-block;padding:14px 26px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;border-radius:10px;color:white;font-size:14px;font-weight:700;text-decoration:none;">
        💬 Falar no WhatsApp
      </a>
    </div>

    <div style="text-align:center;padding:24px;font-size:12px;color:#3a3b50;">
      GLR Consultoria © 2026
      <div style="margin-top:8px;">
        <a href="javascript:void(0)" onclick="window.mostrarLogin()" style="font-size:11px;color:#3a3b50;text-decoration:underline;">Acesso ao sistema</a>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // FAQ accordion
  overlay.querySelectorAll('.glr-faq-q').forEach(q => {
    q.addEventListener('click', () => {
      const item = q.closest('.glr-faq-item');
      const aberto = item.style.getPropertyValue('--open') === '1';
      overlay.querySelectorAll('.glr-faq-a').forEach(a => a.style.maxHeight = '0');
      if (!aberto) {
        overlay.querySelectorAll('.glr-faq-item').forEach(it => it.style.setProperty('--open', '0'));
        item.style.setProperty('--open', '1');
        const a = item.querySelector('.glr-faq-a');
        a.style.maxHeight = a.scrollHeight + 'px';
      } else {
        item.style.setProperty('--open', '0');
      }
    });
  });
}

// ── Tela de Login ─────────────────────────────────────────────
function mostrarLogin(erroMsg) {
  document.getElementById('glr-login-overlay')?.remove();
  document.getElementById('glr-vendas-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'glr-login-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;background:#0d0d14;
    display:flex;align-items:center;justify-content:center;z-index:9999;
    font-family:'Inter',sans-serif;
  `;
  overlay.innerHTML = `
    <div style="background:#16161f;border:1px solid rgba(255,255,255,0.07);border-radius:20px;
                padding:44px 40px;width:100%;max-width:420px;box-shadow:0 32px 80px rgba(0,0,0,0.6);position:relative;">

      <button onclick="window.mostrarVendas()" title="Voltar"
        style="position:absolute;top:20px;left:20px;background:none;border:none;color:#5a5b72;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:4px;">
        ← Voltar
      </button>

      <div style="text-align:center;margin-bottom:36px;">
        <div style="width:80px;height:80px;margin:0 auto 16px;overflow:hidden;">
          <img src="logo.png" alt="GLR" style="width:80px;height:80px;object-fit:contain;mix-blend-mode:screen;"
               onerror="this.parentElement.innerHTML='<span style=\'font-size:22px;font-weight:800;color:white;letter-spacing:-1px;\'>GLR</span>'">
        </div>
        <h1 style="font-size:22px;font-weight:800;color:#f1f1f8;margin:0 0 6px;">GLR Consultoria</h1>
        <p style="font-size:14px;color:#5a5b72;margin:0;">Centro de Operações</p>
      </div>

      ${erroMsg ? `
        <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:8px;
                    padding:10px 14px;margin-bottom:20px;font-size:13px;color:#ef4444;text-align:center;">
          ${erroMsg}
        </div>` : ''}

      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:11px;font-weight:600;color:#5a5b72;
                      text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;">E-mail</label>
        <input id="glr-email" type="email" placeholder="seu@email.com" autocomplete="email"
          style="width:100%;padding:11px 14px;background:#0d0d14;border:1px solid rgba(255,255,255,0.08);
                 border-radius:10px;color:#f1f1f8;font-size:14px;outline:none;box-sizing:border-box;transition:border .15s;"
          onfocus="this.style.borderColor='#6366f1'" onblur="this.style.borderColor='rgba(255,255,255,0.08)'">
      </div>

      <div style="margin-bottom:28px;">
        <label style="display:block;font-size:11px;font-weight:600;color:#5a5b72;
                      text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;">Senha</label>
        <input id="glr-senha" type="password" placeholder="••••••••" autocomplete="current-password"
          style="width:100%;padding:11px 14px;background:#0d0d14;border:1px solid rgba(255,255,255,0.08);
                 border-radius:10px;color:#f1f1f8;font-size:14px;outline:none;box-sizing:border-box;transition:border .15s;"
          onfocus="this.style.borderColor='#6366f1'" onblur="this.style.borderColor='rgba(255,255,255,0.08)'"
          onkeydown="if(event.key==='Enter') window.fazerLogin()">
      </div>

      <button id="glr-login-btn" onclick="window.fazerLogin()"
        style="width:100%;padding:13px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;
               border-radius:10px;color:white;font-size:15px;font-weight:700;cursor:pointer;
               transition:opacity .15s;letter-spacing:0.2px;">
        Entrar
      </button>

      <p style="text-align:center;margin:20px 0 0;font-size:12px;color:#3a3b50;">
        GLR Consultoria © 2026
      </p>
    </div>

    <style>
      @keyframes fadeInUp {
        from { opacity:0; transform:translateX(-50%) translateY(8px); }
        to   { opacity:1; transform:translateX(-50%) translateY(0); }
      }
    </style>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('glr-email')?.focus(), 100);
}

// ── Fazer Login ───────────────────────────────────────────────
window.fazerLogin = async function() {
  const email = document.getElementById('glr-email')?.value?.trim();
  const senha = document.getElementById('glr-senha')?.value;
  const btn   = document.getElementById('glr-login-btn');

  if (!email || !senha) { mostrarLogin('Preencha e-mail e senha.'); return; }

  if (btn) { btn.textContent = 'Entrando...'; btn.disabled = true; btn.style.opacity = '0.7'; }

  const { error } = await _sb.auth.signInWithPassword({ email, password: senha });

  if (error) {
    mostrarLogin('E-mail ou senha incorretos. Tente novamente.');
    return;
  }

  // Verifica tipo ANTES de expor qualquer conteúdo
  const portalCfg = await _detectarPortalCliente(email);

  document.getElementById('glr-login-overlay')?.remove();

  if (portalCfg) {
    // Cliente do portal — NÃO sincroniza dados admin, NÃO ativa realtime admin
    atualizarSidebarUsuario();
    if (typeof window._initPortalCliente === 'function') await window._initPortalCliente(portalCfg);
    return;
  }

  // Admin GLR — limpa qualquer estado do portal e inicia normalmente
  window._portalConfig = null;
  await sincronizarDoSupabase();
  ativarRealtime();
  atualizarSidebarUsuario();
  if (typeof carregarDadosSalvos === 'function') carregarDadosSalvos();
  if (typeof Router !== 'undefined') {
    const rotasPortal = ['portal-dashboard','portal-vendas','curva-abc'];
    const hashAtual = window.location.hash.replace('#','');
    if (rotasPortal.includes(hashAtual)) Router.navigate('dashboard');
    else if (typeof Router.resolve === 'function') Router.resolve();
  }
  if (typeof atualizarBadges === 'function') atualizarBadges();
};

// ── Fazer Logout ──────────────────────────────────────────────
window.fazerLogout = async function() {
  window._portalConfig = null;
  await _sb.auth.signOut();
  GLR_KEYS.forEach(k => localStorage.removeItem(k));
  mostrarLogin();
};

// ── Atualiza sidebar com info do usuário logado ───────────────
async function atualizarSidebarUsuario() {
  const { data: { user } } = await _sb.auth.getUser();
  if (!user) return;

  const emailCurto = user.email.split('@')[0];
  const iniciais   = emailCurto.slice(0,2).toUpperCase();

  const avatar = document.querySelector('#sidebar .user-avatar');
  const nome   = document.querySelector('#sidebar .user-info strong');
  const cargo  = document.querySelector('#sidebar .user-info span');
  const headerAvatar = document.querySelector('#header .header-actions div[style*="border-radius:50%"]');

  if (avatar) avatar.textContent = iniciais;
  if (nome)   nome.textContent   = emailCurto;
  if (cargo)  cargo.textContent  = user.email;
  if (headerAvatar) headerAvatar.textContent = iniciais;
}

// ── Revela o app e remove o overlay de loading ──
// O overlay e o #app{visibility:hidden} estão no HTML/CSS, bloqueando desde o início.
function _ocultarLoadingInicial() {
  document.getElementById('glr-loading-inicial')?.remove();
  const app = document.getElementById('app');
  if (app) app.style.visibility = 'visible';
}

// ── Inicialização ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // O overlay e #app{visibility:hidden} já estão no HTML — não precisamos criar nada.
  // Qualquer erro aqui revelaria uma tela em branco; o try/finally garante fallback.
  try {
    const { data: { session } } = await _sb.auth.getSession();

    if (!session) {
      _ocultarLoadingInicial();
      mostrarVendas();
      return;
    }

    const userEmail = session.user?.email || '';

    // Verifica tipo ANTES de sincronizar qualquer dado admin
    const portalCfg = await _detectarPortalCliente(userEmail);

    if (portalCfg) {
      // Cliente do portal — NUNCA sincroniza dados admin, NUNCA ativa realtime admin
      _ocultarLoadingInicial();
      atualizarSidebarUsuario();
      if (typeof window._initPortalCliente === 'function') await window._initPortalCliente(portalCfg);
      return;
    }

    // Admin GLR — limpa qualquer estado do portal e inicia normalmente
    window._portalConfig = null;
    await sincronizarDoSupabase();
    ativarRealtime();
    _ocultarLoadingInicial();
    atualizarSidebarUsuario();
    if (typeof Router !== 'undefined') {
      const rotasPortal = ['portal-dashboard','portal-vendas','curva-abc'];
      const hashAtual = window.location.hash.replace('#','');
      if (rotasPortal.includes(hashAtual)) Router.navigate('dashboard');
    }

  } catch (err) {
    console.error('[GLR] Erro na inicialização:', err);
    _ocultarLoadingInicial();
    mostrarLogin('Erro ao inicializar. Tente novamente.');
  }
});

// ── Detecta se email é de cliente do portal ───────────────────
async function _detectarPortalCliente(email) {
  try {
    // Tenta localStorage primeiro
    let configs = JSON.parse(localStorage.getItem('glr_portal_configs')||'[]');

    // Se não encontrou, busca direto no Supabase (garante dados frescos)
    if (!configs.length) {
      const { data } = await _sb.from('glr_storage').select('dados').eq('chave','glr_portal_configs').single();
      if (data?.dados) {
        configs = Array.isArray(data.dados) ? data.dados : [];
        localStorage.setItem('glr_portal_configs', JSON.stringify(configs));
      }
    }

    const cfg = configs.find(c => c.email?.toLowerCase() === email?.toLowerCase() && c.ativo !== false);
    return cfg || null;
  } catch { return null; }
}
