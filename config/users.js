// Configuração de usuários e papéis (roles).
//
// Acesso ÚNICO: o login pede só uma senha (sem usuário) e mostra tudo.
// O "administrativo" continua à parte (página admin.html + senha mestra, ver config/admin.js).
//
// Senha padrão = "7766". Para trocar em produção sem mexer no código,
// defina a ENV var USER_EQUIPE_HASH — ela tem prioridade sobre o hash daqui.
// Use `npm run hash -- <novaSenha>` para gerar um novo hash.

const DEFAULT_HASHES = {
  equipe: '$2a$10$PYa0gbX6aNVqaWz9/z4HvuQ5tjqGVz22TA7x3hlSl4gueMp6W0zaW',
};

function hashFor(username) {
  return process.env[`USER_${username.toUpperCase()}_HASH`] || DEFAULT_HASHES[username];
}

const USERS = {
  equipe: { username: 'equipe', name: 'Canal Loja', role: 'master', passwordHash: hashFor('equipe') },
};

// Mesma estrutura é usada no servidor (filtrar APIs) e enviada ao cliente
// (filtrar UI). Mantenha as duas em sincronia se editar.
const ROLES = {
  // Acesso único: vê todas as abas e todos os PDVs. O administrativo (upload de
  // planilhas + metas globais) fica na Área Admin, protegida por senha mestra.
  master: {
    label: 'Acesso geral',
    allowedPdvs: '*',
    tabs: ['loja', 'hub', 'comparativo', 'ranking', 'servicos', 'digital'],
    sections: ['dashboard'],
    editable: {
      global:  ['metaPRM', 'metaTurbinado', 'metaID', 'metaResgate', 'metaBBX'],
      hub:     ['metaSkinLoja', 'metaNPS', 'metaItensBoleto', 'metaAuditoria',
                'metaReceitaLoja', 'metaBoleto', 'npsLoja', 'auditoriaLoja',
                'sellerMetas'],
      digital: ['metaDigitalReceita', 'metaDigitalConversao', 'metaDigitalBM'],
    },
  },
};

function publicProfile(username) {
  const u = USERS[username];
  if (!u) return null;
  return { username: u.username, name: u.name, role: u.role, perms: ROLES[u.role] };
}

module.exports = { USERS, ROLES, publicProfile };
