// Login do analista (o mesmo do sistema da GLR) e estado da conexão
const raiz = document.getElementById('raiz');
const enviar = m => new Promise(r => chrome.runtime.sendMessage(m, r));
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function mostrar() {
  const st = await enviar({ tipo: 'estado' });
  if (st?.email) {
    raiz.innerHTML = `<div class="ok">Conectado como <b>${esc(st.email)}</b>.</div>
      <p style="margin-top:10px">Abra uma campanha em <b>Publicidade → Product Ads</b> no Mercado Livre: o pacote do dia da GLR aparece no canto da tela.</p>
      <button class="sec" id="sair">Sair</button>`;
    document.getElementById('sair').onclick = async () => { await enviar({ tipo: 'sair' }); mostrar(); };
    return;
  }
  raiz.innerHTML = `<p>Entre com o seu login do sistema da GLR.</p>
    <form id="f"><label for="em">E-mail</label><input id="em" type="email" autocomplete="username" required>
    <label for="se">Senha</label><input id="se" type="password" autocomplete="current-password" required>
    <button type="submit">Entrar</button><div class="erro" id="er"></div></form>`;
  document.getElementById('f').onsubmit = async e => {
    e.preventDefault();
    const bt = e.target.querySelector('button'); bt.disabled = true; bt.textContent = 'Entrando…';
    const r = await enviar({ tipo: 'entrar', email: document.getElementById('em').value.trim(), senha: document.getElementById('se').value });
    if (r?.ok) return mostrar();
    document.getElementById('er').textContent = r?.erro || 'Não consegui entrar.';
    bt.disabled = false; bt.textContent = 'Entrar';
  };
}
mostrar();
