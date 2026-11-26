// Baixa uma foto de referência sem seguir endereço arbitrário.
// Só https, só hosts de imagem conhecidos, sem IP privado, sem redirecionar
// no escuro, com teto de tamanho e de tempo, e só se os bytes forem imagem.
const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECIONAMENTOS = 2;

const HOSTS = [
  /(^|\.)mlstatic\.com$/i,
  /(^|\.)susercontent\.com$/i,
  /(^|\.)shopee\.com\.br$/i,
  /(^|\.)shopeemobile\.com$/i,
  /(^|\.)tiktokcdn\.com$/i,
  /(^|\.)tiktokcdn-us\.com$/i,
  /(^|\.)ibyteimg\.com$/i,
  /(^|\.)supabase\.co$/i,
  /^consultoriaglr\.com\.br$/i,
];

function ipPrivado(ip) {
  const versao = net.isIP(ip);
  if (versao === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (versao === 6) {
    const n = ip.toLowerCase();
    if (n === '::1' || n === '::') return true;
    if (n.startsWith('fe80') || n.startsWith('fc') || n.startsWith('fd')) return true;
    if (n.startsWith('::ffff:')) return ipPrivado(n.slice(7));
    return false;
  }
  return true;
}

function hostPermitido(hostname) {
  return HOSTS.some(re => re.test(hostname));
}

function tipoDaImagem(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 6 && buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

async function conferirHost(hostname) {
  if (!hostPermitido(hostname)) throw new Error('Endereço da foto não permitido.');
  let ips = [];
  try { ips = await dns.lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new Error('Não consegui resolver o endereço da foto.'); }
  if (!ips.length || ips.some(x => ipPrivado(x.address))) throw new Error('Endereço da foto não permitido.');
}

async function baixarImagem(urlInicial) {
  let atual = String(urlInicial || '');
  for (let hop = 0; hop <= MAX_REDIRECIONAMENTOS; hop++) {
    let url;
    try { url = new URL(atual); }
    catch { throw new Error('Endereço da foto inválido.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('A foto precisa ser um endereço https.');
    await conferirHost(url.hostname);
    const r = await fetch(url.href, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) throw new Error('A foto redirecionou sem destino.');
      atual = new URL(loc, url).href;
      continue;
    }
    if (!r.ok) throw new Error('Não consegui baixar a foto de referência.');
    const declarado = Number(r.headers.get('content-length'));
    if (Number.isFinite(declarado) && declarado > MAX_BYTES) throw new Error('Foto grande demais.');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('Foto grande demais.');
    const mime = tipoDaImagem(buf);
    if (!mime) throw new Error('O arquivo não é uma imagem JPEG, PNG, WebP ou GIF.');
    return { mimeType: mime, data: buf.toString('base64') };
  }
  throw new Error('A foto redirecionou demais.');
}

module.exports = { baixarImagem, ipPrivado, hostPermitido, tipoDaImagem };
