/**
 * Half cashout during RUNNING: place MANUAL bet (no auto cashout), wait RUNNING, emit HALF cashout.
 * Not included in npm run test:all (timing-sensitive).
 */
const {
  BASE_BET_PAYLOAD,
  validateRequiredConfig,
} = require("../config/config");
const {
  loadProtoTypes,
  buildSocket,
  waitConnected,
  enterGame,
  waitForBettingPhase,
  waitForRunningPhase,
  placeBet,
  cashout,
  snapshotPhase,
  snapshotRoundId,
  enterGameAckLogFields,
  betIdStringFromPlaceBetRet,
} = require("../helpers/cgSocketHelpers");

(async () => {
  validateRequiredConfig();
  const types = await loadProtoTypes();
  const socket = buildSocket();

  await waitConnected(socket);
  console.log("[connected]", socket.id);

  try {
    console.log("[step1] enter game");
    const enterRet = await enterGame(socket, types);
    const { roomId, currentCount } = enterGameAckLogFields(enterRet, types);
    console.log("[step1 ack]", { roomId, currentCount });

    console.log("[step2] wait betting phase");
    const snapBetting = await waitForBettingPhase(socket, types, roomId);
    const roundId = snapshotRoundId(snapBetting);
    console.log("[step2 ack]", { phase: snapshotPhase(snapBetting), roundId });

    console.log("[step3] place bet (MANUAL, no auto — required for HALF)");
    const betRet = await placeBet(socket, types, {
      ...BASE_BET_PAYLOAD,
      roomId,
      roundId,
      cashoutType: "MANUAL",
      autoCashoutAt: "0",
    });
    const betId = betIdStringFromPlaceBetRet(betRet, types);
    console.log("[step3 ack]", { betId });
    if (!betId || betId === "0") {
      throw new Error("Place bet failed: no betId returned");
    }

    console.log("[step4] wait RUNNING for same round");
    await waitForRunningPhase(socket, types, roomId, roundId);
    console.log("[step4 ok] phase=RUNNING");

    const now = Date.now();
    console.log("[step5] half cashout", { betId, roundId, roomId, cashoutTime: now });
    const coRet = await cashout(socket, types, {
      roundId,
      roomId,
      betId,
      cashoutTime: now,
      cashoutType: "HALF",
    });
    console.log("[step5 ack]", { status: coRet.status });

    if (!coRet.status) {
      throw new Error("Half cashout failed: server returned status=false");
    }

    console.log("[PASS] half-cashout.js finished");
  } finally {
    socket.disconnect();
  }
})().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
