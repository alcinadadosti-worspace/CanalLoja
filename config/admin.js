// Senha mestra do Admin — quem tiver essa senha pode subir as 5 planilhas.
// Default = "admin". Em produção, sobrescrever via ENV ADMIN_PASSWORD_HASH.
// Gere um hash novo com: npm run hash -- <novaSenha>

const DEFAULT_ADMIN_HASH = '$2a$10$sstr2qj1oLJ7YNr1OBtwL.nm7moGZ3aDUw/WBEvT/EQbMZJVNEEYS';

module.exports = {
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH || DEFAULT_ADMIN_HASH,
};
