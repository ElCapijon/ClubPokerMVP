import { io } from 'socket.io-client';
import { getToken } from './auth';

// In production (same-origin), use empty string for auto-detect.
// In development, connect to the backend dev server.
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || (import.meta.env.PROD ? '' : 'http://localhost:3000');

let socket = null;

export function getSocket() {
  return socket;
}

export function connect() {
  const token = getToken();
  if (!token) {
    console.error('[Socket] No auth token available');
    return null;
  }

  if (socket && socket.connected) {
    return socket;
  }

  // If socket exists but disconnected, update its auth and reconnect
  if (socket) {
    socket.auth = { token };
    socket.connect();
    return socket;
  }

  socket = io(SOCKET_URL, {
    auth: { token },
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 2000,
  });

  socket.connect();
  return socket;
}

export function disconnect() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
