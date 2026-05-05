const path = require("path");
const io = require("socket.io-client");
const protobuf = require("protobufjs");
const { emitWithAck, toBuf, int64ToDecimalString } = require("./commons");
const {
  HOST,
  SOCKET_PATH,
  TRANSPORTS,
  ACCESS_TOKEN,
  PLATFORM,
  GAME_ID,
  ACK_TIMEOUT_MS,
  WAIT_BETTING_TIMEOUT_MS,
  SNAPSHOT_FALLBACK_POLL_MS,
  WAIT_RUNNING_TIMEOUT_MS,
  NEGATIVE_ACK_TIMEOUT_MS,
} = require("../config/config");

const PROTO_DIR = path.resolve(__dirname, "../proto");

async function loadProtoTypes() {
  const rootClient = await protobuf.load(path.join(PROTO_DIR, "client.proto"));
  const rootServer = await protobuf.load(path.join(PROTO_DIR, "server.proto"));

  return {
    EnterGame: rootClient.lookupType("com.hg.socket.server.protocol.EnterGame"),
    /** client:room:snapshot request body ({ room_id }) */
    Snapshot: rootClient.lookupType("com.hg.socket.server.protocol.Snapshot"),
    /** server:room:snapshot payload / snapshot ack ({ roomId, roundId, room_phase, … }) */
    ServerSnapshot: rootServer.lookupType("com.hg.socket.server.protocol.Snapshot"),
    RoomPhase: rootServer.lookupType("com.hg.socket.server.protocol.RoomPhase"),
    PlaceBet: rootClient.lookupType("com.hg.socket.server.protocol.PlaceBet"),
    Cashout: rootClient.lookupType("com.hg.socket.server.protocol.Cashout"),
    EnterGameRet: rootServer.lookupType("com.hg.socket.server.protocol.EnterGameRet"),
    SnapshotRet: rootServer.lookupType("com.hg.socket.server.protocol.SnapshotRet"),
    RoundSnapshot: rootServer.lookupType(
      "com.hg.socket.server.protocol.RoundSnapshot"
    ),
    PlaceBetRet: rootServer.lookupType("com.hg.socket.server.protocol.PlaceBetRet"),
    CashoutRet: rootServer.lookupType("com.hg.socket.server.protocol.CashoutRet"),
  };
}

/** room_id from EnterGameRet — never use Number(); Snowflake IDs exceed MAX_SAFE_INTEGER. */
function roomIdStringFromEnterRet(enterRet, types) {
  const o = types.EnterGameRet.toObject(enterRet, {
    longs: String,
    defaults: true,
  });
  return o.roomId != null && o.roomId !== "" ? String(o.roomId) : "";
}

/** bet_id from PlaceBetRet — lossless string for comparisons / Cashout payloads. */
function betIdStringFromPlaceBetRet(betRet, types) {
  const o = types.PlaceBetRet.toObject(betRet, {
    longs: String,
    defaults: true,
  });
  if (o.betId != null && o.betId !== "") return String(o.betId);
  return int64ToDecimalString(betRet.betId);
}

/** { roomId, currentCount } for logging after enterGame — roomId is lossless string. */
function enterGameAckLogFields(enterRet, types) {
  const roomId = roomIdStringFromEnterRet(enterRet, types);
  const o = types.EnterGameRet.toObject(enterRet, {
    longs: String,
    defaults: true,
  });
  const currentCount =
    o.currentCount != null ? o.currentCount : enterRet.currentCount;
  return { roomId, currentCount };
}

function buildSocket() {
  const socket = io(HOST, {
    path: SOCKET_PATH,
    transports: TRANSPORTS,
    timeout: 5000,
    reconnection: false,
    query: {
      access_token: ACCESS_TOKEN,
      platform: PLATFORM,
      game_id: GAME_ID,
    },
  });

  socket.on("connect_error", (err) =>
    console.error("[socket connect_error]", err && err.message)
  );
  socket.on("disconnect", (reason) =>
    console.log("[socket disconnect]", reason)
  );

  return socket;
} 

async function waitConnected(socket, timeoutMs = 10000) {
  if (socket.connected) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Socket connect timeout")),
      timeoutMs
    );
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Socket connect failed: ${err && err.message}`));
    });
  });
}

function encodeToBase64(messageType, payload) {
  const message = messageType.create(payload);
  const bytes = messageType.encode(message).finish();
  return Buffer.from(bytes).toString("base64");
}

async function enterGame(socket, types, timeoutMs = ACK_TIMEOUT_MS) {
  const encodedB64 = encodeToBase64(types.EnterGame, {});
  const ack = await emitWithAck(socket, "client:game:enter", encodedB64, {
    timeoutMs,
  });
  return types.EnterGameRet.decode(toBuf(ack));
}

async function getSnapshot(socket, types, roomId, timeoutMs = ACK_TIMEOUT_MS) {
  const encodedB64 = encodeToBase64(types.Snapshot, { roomId });
  const ack = await emitWithAck(socket, "client:room:snapshot", encodedB64, {
    timeoutMs,
  });
  return types.ServerSnapshot.decode(toBuf(ack));
}

// Phase is now nested: snapshot.roomPhase.phase (proto field room_phase → camelCase roomPhase)
function snapshotPhase(snap) {
  return (snap.roomPhase && snap.roomPhase.phase) || "";
}

function snapshotRoundId(snap) {
  const v = snap.roundId;
  return v != null ? int64ToDecimalString(v) : "0";
}

/**
 * Wait until condition holds, preferring server:room:snapshot push; falls back to slow getSnapshot.
 * Resolves with latest SnapshotRet (pull) so callers keep phase/round/bet_details etc.
 */
function waitForSnapshot(
  socket,
  types,
  roomId,
  timeoutMs,
  { matchesPhase, matchesSnapshot, timeoutMessage }
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let fallbackId;
    const deadline = Date.now() + timeoutMs;

    const cleanup = () => {
      if (fallbackId) clearInterval(fallbackId);
      socket.off("server:room:game:phase", onRoomPhase);
      socket.off("server:room:snapshot", onEnterSnapshot);
    };

    const finishOk = () => {
      if (settled) return;
      settled = true;
      cleanup();
      getSnapshot(socket, types, roomId).then(resolve).catch(reject);
    };

    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    // Phase-change broadcast: trigger an immediate pull to confirm roundId
    const onRoomPhase = (data) => {
      try {
        const rp = types.RoomPhase.decode(toBuf(data));
        if (matchesPhase(rp)) finishOk();
      } catch (_) {}
    };

    // Snapshot pushed after game enter (same event name as other snapshot pushes from server)
    const onEnterSnapshot = (data) => {
      try {
        const snap = types.ServerSnapshot.decode(toBuf(data));
        if (matchesSnapshot(snap)) finishOk();
      } catch (_) {}
    };

    const tryPull = async () => {
      if (settled) return;
      if (Date.now() >= deadline) {
        finishErr(new Error(timeoutMessage));
        return;
      }
      try {
        const snapshot = await getSnapshot(socket, types, roomId);
        if (matchesSnapshot(snapshot)) finishOk();
      } catch (_) {}
    };

    socket.on("server:room:game:phase", onRoomPhase);
    socket.on("server:room:snapshot", onEnterSnapshot);
    tryPull();
    fallbackId = setInterval(tryPull, SNAPSHOT_FALLBACK_POLL_MS);
  });
}

async function waitForBettingPhase(
  socket,
  types,
  roomId,
  timeoutMs = WAIT_BETTING_TIMEOUT_MS
) {
  return waitForSnapshot(socket, types, roomId, timeoutMs, {
    matchesPhase: (rp) => rp.phase === "BETTING",
    matchesSnapshot: (snap) =>
      snapshotPhase(snap) === "BETTING" && snapshotRoundId(snap) !== "0",
    timeoutMessage: "Could not reach BETTING phase within timeout",
  });
}

/**
 * Wait until snapshot shows RUNNING for the same round we bet on.
 */
async function waitForRunningPhase(
  socket,
  types,
  roomId,
  expectedRoundId,
  timeoutMs = WAIT_RUNNING_TIMEOUT_MS
) {
  const want = int64ToDecimalString(expectedRoundId);
  return waitForSnapshot(socket, types, roomId, timeoutMs, {
    matchesPhase: (rp) => rp.phase === "RUNNING",
    matchesSnapshot: (snap) =>
      snapshotPhase(snap) === "RUNNING" && snapshotRoundId(snap) === want,
    timeoutMessage: `Could not reach RUNNING phase for round ${want} within ${timeoutMs}ms`,
  });
}

async function placeBet(socket, types, payload, timeoutMs = ACK_TIMEOUT_MS) {
  const encodedB64 = encodeToBase64(types.PlaceBet, payload);
  const ack = await emitWithAck(socket, "client:bet:place", encodedB64, {
    timeoutMs,
  });
  return types.PlaceBetRet.decode(toBuf(ack));
}

async function cashout(socket, types, payload, timeoutMs = ACK_TIMEOUT_MS) {
  const encodedB64 = encodeToBase64(types.Cashout, payload);
  const ack = await emitWithAck(socket, "client:bet:cashout", encodedB64, {
    timeoutMs,
  });
  return types.CashoutRet.decode(toBuf(ack));
}

module.exports = {
  loadProtoTypes,
  buildSocket,
  waitConnected,
  enterGame,
  getSnapshot,
  waitForBettingPhase,
  waitForRunningPhase,
  placeBet,
  cashout,
  NEGATIVE_ACK_TIMEOUT_MS,
  snapshotPhase,
  snapshotRoundId,
  int64ToDecimalString,
  roomIdStringFromEnterRet,
  betIdStringFromPlaceBetRet,
  enterGameAckLogFields,
};
