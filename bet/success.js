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
  placeBet,
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
    console.log("[step1 ack]", {
      roomId,
      currentCount,
    });

    console.log("[step2] wait betting phase");
    const snapshot = await waitForBettingPhase(socket, types, roomId);
    const roundId = snapshotRoundId(snapshot);
    console.log("[step2 ack]", { phase: snapshotPhase(snapshot), roundId });

    console.log("[step3] place bet");
    const betRet = await placeBet(socket, types, {
      ...BASE_BET_PAYLOAD,
      roomId,
      roundId,
    });

    const betId = betIdStringFromPlaceBetRet(betRet, types);
    console.log("[step3 ack]", { betId });

    if (!betId || betId === "0") {
      throw new Error("Expected non-zero betId on success");
    }

    console.log("[PASS] success.js finished");
  } finally {
    socket.disconnect();
  }
})().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
