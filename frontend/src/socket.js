import { io } from 'socket.io-client';

// In production (same-origin), use empty string for auto-detect.
// In development, connect to the backend dev server.
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || (import.meta.env.PROD ? '' : 'http://localhost:3000');

let socket = null;

export function getSocket() {
  if (!socket) {
    socket = io(SOCKET_URL, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
    });
  }
  return socket;
}

export function connect() {
  const s = getSocket();
  if (!s.connected) {
    s.connect();
  }
  return s;
}

export function disconnect() {
  if (socket && socket.connected) {
    socket.disconnect();
  }
}
