// Utilitários compartilhados entre telão e celular
const FORMAS = [
  '<svg class="forma" viewBox="0 0 24 24"><path d="M12 3 22 20H2z"/></svg>',
  '<svg class="forma" viewBox="0 0 24 24"><path d="M12 2 22 12 12 22 2 12z"/></svg>',
  '<svg class="forma" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
  '<svg class="forma" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
];
const LETRAS = ['A', 'B', 'C', 'D'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return Number(n || 0).toLocaleString('pt-BR'); }
function $(sel, root = document) { return root.querySelector(sel); }

// Marca: usa /logo se existir (coloque public/logo.png), senão um selo + nome
function montarMarca(el) {
  const img = new Image();
  img.alt = 'Ouro Safra';
  img.onload = () => { el.innerHTML = ''; el.appendChild(img); };
  img.src = '/logo';
  el.innerHTML = '<span class="selo"></span><span class="nome"><b>OURO</b> SAFRA</span>';
}

// Linhas douradas onduladas (elemento da identidade)
function ondas() {
  return `<svg class="ondas" viewBox="0 0 1440 300" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 210 C 240 150, 480 270, 720 205 S 1200 140, 1440 200" fill="none" stroke="#FFC20F" stroke-width="3" opacity=".55"/>
    <path d="M0 240 C 260 180, 500 300, 760 235 S 1220 175, 1440 230" fill="none" stroke="#F7C948" stroke-width="2" opacity=".6"/>
    <path d="M0 268 C 280 215, 520 320, 800 262 S 1240 210, 1440 258" fill="none" stroke="#5E9A3A" stroke-width="2" opacity=".35"/>
  </svg>`;
}

// Relógio sincronizado com o servidor
let offset = 0;
function syncClock(serverNow) { if (serverNow) offset = serverNow - Date.now(); }
function agora() { return Date.now() + offset; }
