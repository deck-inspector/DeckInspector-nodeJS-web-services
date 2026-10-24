module.exports = {
    Admin: 'admin',
    User: 'user',
    // Owner / property-manager portal login: read-only, own portfolio only
    // (Oct 23 2026, enforced by service/clientAccess.js).
    Client: 'client',
    // The client's contractor / maintenance crew: uploads repair photos only, on
    // the properties the client assigned to it (Oct 23 2026, repairs portal).
    Contractor: 'contractor'
  }