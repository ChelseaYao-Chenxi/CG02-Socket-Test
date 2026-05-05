require("dotenv").config();

const { ACCESS_TOKEN, PLATFORM, GAME_ID } = require("./secrets");

const HOST = process.env.CG02_SOCKET_HOST || "http://localhost:8400";
const SOCKET_PATH = process.env.CG02_SOCKET_PATH || "/game/cg01/socket.io";
const TRANSPORTS = ["websocket"];
const ACK_TIMEOUT_MS = Number(process.env.CG02_ACK_TIMEOUT_MS || 5000);
const WAIT_BETTING_TIMEOUT_MS = Number(
  process.env.CG02_WAIT_BETTING_TIMEOUT_MS || 12000
);
/**
 * Slow client:room:snapshot pull fallback when push is missed (e.g. old server).
 * Prefer server:room:snapshot broadcast; default 2000ms keeps load low.
 */
const SNAPSHOT_FALLBACK_POLL_MS = Number(
  process.env.CG02_SNAPSHOT_FALLBACK_POLL_MS ||
    process.env.CG02_SNAPSHOT_POLL_MS ||
    2000
);
const WAIT_RUNNING_TIMEOUT_MS = Number(
  process.env.CG02_WAIT_RUNNING_TIMEOUT_MS || 30000
);
/** Short ack timeout for negative / error-path scripts expecting a quick ack or timeout. */
const NEGATIVE_ACK_TIMEOUT_MS = Number(
  process.env.CG02_NEGATIVE_ACK_TIMEOUT_MS || 3000
);

const BASE_BET_PAYLOAD = {
  betAmount: process.env.CG02_BET_AMOUNT || "0.10",
  currency: process.env.CG02_CURRENCY || "CNY",
  cashoutType: process.env.CG02_CASHOUT_TYPE || "MANUAL",
  autoCashoutAt: process.env.CG02_AUTO_CASHOUT_AT || "0",
  panel: process.env.CG02_PANEL || "A",
};

function validateRequiredConfig() {
  if (!ACCESS_TOKEN) {
    throw new Error("Missing required env: CG02_ACCESS_TOKEN");
  }
}

module.exports = {
  HOST,
  SOCKET_PATH,
  TRANSPORTS,
  ACK_TIMEOUT_MS,
  WAIT_BETTING_TIMEOUT_MS,
  SNAPSHOT_FALLBACK_POLL_MS,
  WAIT_RUNNING_TIMEOUT_MS,
  NEGATIVE_ACK_TIMEOUT_MS,
  ACCESS_TOKEN,
  PLATFORM,
  GAME_ID,
  BASE_BET_PAYLOAD,
  validateRequiredConfig,
};
