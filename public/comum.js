// Utilitários compartilhados entre telão e celular
// Ícones próprios das alternativas, com tema do campo: sol, folha, espiga e gota
const FORMAS = [
  // A · Sol
  '<svg class="forma" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.6"/><g>' +
    [0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<rect x="11" y="1.2" width="2" height="4.2" rx="1" transform="rotate(${a} 12 12)"/>`).join('') +
    '</g></svg>',
  // B · Folha
  '<svg class="forma" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M20.5 3.5C11 3.6 4.6 8.6 4.6 15.4c0 1.4.3 2.6.8 3.6L3.2 21.2l1.1 1.1 2.3-2.3c1 .6 2.3.9 3.7.9 6.8 0 11.2-6.8 10.2-17.4zM8.2 17.6l-1-1c2.5-3.6 5.6-6.3 9.4-8.2l.6 1.1c-3.6 1.9-6.6 4.6-9 8.1z"/></svg>',
  // C · Espiga
  '<svg class="forma" viewBox="0 0 24 24"><rect x="11.2" y="7" width="1.6" height="16.5" rx=".8"/>' +
    [6.2, 10.6, 15].map((y) =>
      `<ellipse cx="8.7" cy="${y}" rx="1.55" ry="3" transform="rotate(-38 8.7 ${y})"/>` +
      `<ellipse cx="15.3" cy="${y}" rx="1.55" ry="3" transform="rotate(38 15.3 ${y})"/>`).join('') +
    '<ellipse cx="12" cy="3.4" rx="1.6" ry="2.9"/></svg>',
  // D · Gota
  '<svg class="forma" viewBox="0 0 24 24"><path d="M12 1.8c-.4 0-.7.2-.9.5C8.6 6 5 10.6 5 15a7 7 0 0 0 14 0c0-4.4-3.6-9-6.1-12.7-.2-.3-.5-.5-.9-.5z"/></svg>',
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
