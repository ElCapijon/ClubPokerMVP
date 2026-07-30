const AUTH_KEY = 'poker_club_auth';

/**
 * Store user data and JWT token in localStorage.
 */
export function saveAuth(user, token) {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify({ user, token }));
  } catch {
    // Storage full or unavailable
  }
}

/**
 * Load stored auth data.
 */
export function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Clear stored auth data (logout).
 */
export function clearAuth() {
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    // Ignore
  }
}

/**
 * Get the JWT token string.
 */
export function getToken() {
  const auth = loadAuth();
  return auth?.token || null;
}

/**
 * Get the current user object.
 */
export function getUser() {
  const auth = loadAuth();
  return auth?.user || null;
}

/**
 * Check if user is authenticated.
 */
export function isAuthenticated() {
  return !!getToken();
}
