const crypto = require('crypto');

/**
 * Generate a 6-character alphanumeric invite code.
 * Characters: A-Z, 0-9 (uppercase, no lowercase to avoid confusion)
 */
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed I, O, 0, 1 to avoid confusion
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

module.exports = { generateInviteCode };
