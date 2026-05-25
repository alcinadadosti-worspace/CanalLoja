// Configuração de usuários e papéis (roles).
//
// Cada usuária tem: name (exibição), role, passwordHash (bcrypt).
// Senha padrão = primeiro nome em minúsculo (ex: "leidiane").
// Para trocar uma senha em produção sem alterar o código, defina a ENV var
// correspondente (USER_<USERNAME>_HASH) — ela tem prioridade sobre o hash daqui.
// Use `npm run hash -- <novaSenha>` para gerar um novo hash.

const DEFAULT_HASHES = {
  leidiane: '$2a$10$SpyDM9eOcN8bRatoEg.I4elIqjnp23Q3weeOqxxzZiN1JpejMSlh2',
  taciane:  '$2a$10$z4DiPIkZq3lG0QlpIDMklepE97HSKza/yBApvzKh8zLKr4Aln/N.O',
  kemilly:  '$2a$10$arlRrCepxJbMbchdRyNX4u1.CAwR2rxjQ0iIVEMTkCfFR2/oE9Nla',
  mariane:  '$2a$10$pslONKT/LHfjq2blowVJUe5MwrGyQa3k.nStLXSU4SysqXthZXW3O',
};

function hashFor(username) {
  return process.env[`USER_${username.toUpperCase()}_HASH`] || DEFAULT_HASHES[username];
}

const USERS = {
  leidiane: { username: 'leidiane', name: 'Leidiane Souza',    role: 'master',    passwordHash: hashFor('leidiane') },
  taciane:  { username: 'taciane',  name: 'Maria Taciane',     role: 'hub_sul',   passwordHash: hashFor('taciane')  },
  kemilly:  { username: 'kemilly',  name: 'Kemilly Rafaelly',  role: 'hub_norte', passwordHash: hashFor('kemilly')  },
  mariane:  { username: 'mariane',  name: 'Mariane Santos Sousa', role: 'digital',   passwordHash: hashFor('mariane')  },
};

// Mesma estrutura é usada no servidor (filtrar APIs) e enviada ao cliente
// (filtrar UI). Mantenha as duas em sincronia se editar.
const ROLES = {
  master: {
    label: 'Master',
    allowedPdvs: '*',
    tabs: ['loja', 'hub', 'comparativo', 'ranking', 'servicos', 'digital'],
    sections: ['upload', 'store', 'metas', 'generate', 'dashboard', 'output'],
    editable: {
      global:  ['metaPRM', 'metaTurbinado', 'metaID', 'metaResgate', 'metaBBX'],
      hub:     [],
      digital: [],
    },
  },
  hub_sul: {
    label: 'Hub Sul (Penedo · Coruripe · Teotônio)',
    allowedPdvs: ['24669', '24670', '24671'],
    tabs: ['loja', 'hub', 'comparativo', 'ranking', 'servicos'],
    sections: ['upload', 'store', 'metas', 'generate', 'dashboard', 'output'],
    editable: {
      global:  [],
      hub:     ['metaSkinLoja', 'metaNPS', 'metaItensBoleto', 'metaAuditoria',
                'metaReceitaLoja', 'metaBoleto', 'npsLoja', 'auditoriaLoja',
                'sellerMetas'],
      digital: [],
    },
  },
  hub_norte: {
    label: 'Hub Norte (Sustentável · Palmeira · São Sebastião)',
    allowedPdvs: ['24617', '24668', '24303'],
    tabs: ['loja', 'hub', 'comparativo', 'ranking', 'servicos'],
    sections: ['upload', 'store', 'metas', 'generate', 'dashboard', 'output'],
    editable: {
      global:  [],
      hub:     ['metaSkinLoja', 'metaNPS', 'metaItensBoleto', 'metaAuditoria',
                'metaReceitaLoja', 'metaBoleto', 'npsLoja', 'auditoriaLoja',
                'sellerMetas'],
      digital: [],
    },
  },
  digital: {
    label: 'Canal Loja Digital',
    allowedPdvs: '*',
    tabs: ['digital'],
    sections: ['upload', 'metas', 'dashboard'],
    editable: {
      global:  [],
      hub:     [],
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
