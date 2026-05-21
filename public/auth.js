// Helpers de auth disponíveis no app principal.
// Espera window.currentUser injetado pelo servidor antes de carregar.

(function() {
  if (!window.currentUser) return;
  const u = window.currentUser;
  const perms = u.perms || {};

  window.canSeeTab = function(tab) {
    return (perms.tabs || []).includes(tab);
  };

  window.canSeeSection = function(section) {
    return (perms.sections || []).includes(section);
  };

  // Field name precisa estar em uma das 3 listas (global, hub, digital).
  // Tipo é só metadado pra log/debug, não restringe.
  window.canEditField = function(fieldId) {
    const e = perms.editable || {};
    return (e.global || []).includes(fieldId)
        || (e.hub || []).includes(fieldId)
        || (e.digital || []).includes(fieldId);
  };

  // Se 'sellerMetas' está no editable.hub, gestora pode editar metas das consultoras
  window.canEditSellerMetas = function() {
    return (perms.editable?.hub || []).includes('sellerMetas');
  };

  window.allowedPdvs = function() {
    return perms.allowedPdvs;  // '*' ou array
  };

  window.isPdvAllowed = function(pdv) {
    const a = perms.allowedPdvs;
    if (a === '*' || !a) return true;
    return Array.isArray(a) && a.includes(String(pdv));
  };

  window.logout = async function() {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  };
})();
