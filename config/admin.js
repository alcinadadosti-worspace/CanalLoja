// Senha mestra do Admin — quem tiver essa senha pode subir as 5 planilhas.
// Default = "admin". Em produção, sobrescrever via ENV ADMIN_PASSWORD_HASH.
// Gere um hash novo com: npm run hash -- <novaSenha>

const DEFAULT_ADMIN_HASH = '$2a$10$.CYOdFY9yfyrHgB66/32cesvR3zczAl5Euv60n/mMRNMfEICwj0Ke';

if (!process.env.ADMIN_PASSWORD_HASH) {
  console.warn('[admin] Usando senha padrao do admin. Defina ADMIN_PASSWORD_HASH em producao.');
}

module.exports = {
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH || DEFAULT_ADMIN_HASH,
};
