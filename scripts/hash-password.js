#!/usr/bin/env node
// Uso: npm run hash -- <senha>
// Exemplo: npm run hash -- minhaSenhaSegura123
// Copie o hash gerado e cole no Render como ENV var USER_<NOME>_HASH.

const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Uso: npm run hash -- <senha>');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log(hash);
