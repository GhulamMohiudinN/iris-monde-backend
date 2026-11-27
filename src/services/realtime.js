/**
 * Live push to connected browsers, when there is a socket server to push with.
 *
 * On Vercel there is not: the backend runs as short-lived functions that cannot
 * hold a socket open, and index.js only starts Socket.io when run as a normal
 * long-lived server. So everything here is optional by design — with no server
 * registered, emits are silently skipped and the browser picks notifications up
 * on its next poll instead. Moving the backend to a long-running host makes
 * delivery instant with no other change.
 */

let io = null;

const setIo = (instance) => {
  io = instance;
};

const roomForUser = (userId) => `user:${userId}`;

const emitToUser = (userId, event, payload) => {
  if (!io || !userId) return false;
  io.to(roomForUser(String(userId))).emit(event, payload);
  return true;
};

module.exports = { setIo, emitToUser, roomForUser };
