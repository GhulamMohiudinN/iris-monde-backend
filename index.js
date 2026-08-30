// Some networks resolve IPv6 addresses for Google APIs (Gemini, etc.) that
// aren't actually routable, and Node <20's fetch doesn't fall back to IPv4
// the way curl/browsers do — causing outbound calls to hang and time out.
require("dns").setDefaultResultOrder("ipv4first");

const mongoose = require("mongoose");
const { createServer } = require("http");
const { Server } = require("socket.io");
const app = require("./app.js");
const config = require("./src/config/config.js");

// Connect to MongoDB
mongoose
  .connect(config.mongoose.url, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log("MongoDB connection error:", err));

// For local development and socket support
if (require.main === module) {
  const PORT = parseInt(config.port, 10) || 5000;
  const server = createServer(app);
  const io = new Server(server, {
    cors: { origin: true, credentials: true },
    transports: ["websocket", "polling"],
  });

  io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);
    socket.on("disconnect", (reason) => {
      console.log("Socket disconnected:", socket.id, reason);
    });
  });

  // ── Graceful error handler — catches EADDRINUSE so nodemon doesn't loop ──
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[Server] Port ${PORT} is already in use.\n` +
          `Run: npx kill-port ${PORT}   (or: netstat -ano | findstr :${PORT})\n` +
          `Then restart the server.`,
      );
      process.exit(1); // exit cleanly so nodemon won't keep retrying
    } else {
      console.error("[Server] Unexpected error:", err);
      process.exit(1);
    }
  });

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  // ── Graceful shutdown on SIGTERM / SIGINT ─────────────────────────────────
  const shutdown = (signal) => {
    console.log(`\n[Server] ${signal} received — shutting down gracefully`);
    server.close(() => {
      console.log("[Server] HTTP server closed");
      mongoose.connection.close(false, () => {
        console.log("[Server] MongoDB connection closed");
        process.exit(0);
      });
    });
    // Force exit if not done within 10s
    setTimeout(() => process.exit(1), 10_000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = app;
