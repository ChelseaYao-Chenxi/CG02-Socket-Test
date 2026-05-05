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
  NEGATIVE_ACK_TIMEOUT_MS,
  enterGameAckLogFields,
  betIdStringFromPlaceBetRet,
} = require("../helpers/cgSocketHelpers");

function wrongRoundIdFromCurrent(roundIdStr) {
  return (BigInt(roundIdStr) + BigInt(99999)).toString();
}

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
    const snapshot = await waitForBettingPhase(socket, types, roomId);
    const roundId = snapshotRoundId(snapshot);
    console.log("[step2 ack]", { phase: snapshotPhase(snapshot), roundId });

    let passed = 0;
    let total = 0;

    const base = { ...BASE_BET_PAYLOAD, roomId, roundId };

    // Server throws on validation failure; the ack is never sent so placeBet() rejects
    async function expectFail(caseName, payload) {
      total += 1;
      try {
        const ret = await placeBet(socket, types, payload, NEGATIVE_ACK_TIMEOUT_MS);
        console.log(`[case ${caseName}]`, {
          pass: false,
          unexpected: "got ack",
          betId: betIdStringFromPlaceBetRet(ret, types),
        });
      } catch (err) {
        passed += 1;
        console.log(`[case ${caseName}]`, { pass: true, error: err.message });
      }
    }

    // --- Duplicate same-panel: place first bet NOW (before timeout cases consume time) ---
    // Only add this to total if the first bet actually succeeds.
    let firstBetId = "";
    try {
      const first = await placeBet(socket, types, { ...base, panel: "A" });
      firstBetId = betIdStringFromPlaceBetRet(first, types);
      console.log("[case duplicate same panel / setup]", { firstBetId });
    } catch (err) {
      console.log("[case duplicate same panel / setup]", {
        skip: true,
        reason: `first bet threw: ${err.message}`,
      });
    }

    // --- Timeout-based negative cases (each waits NEGATIVE_ACK_TIMEOUT_MS) ---
    await expectFail("invalid panel",   { ...base, panel: "C" });
    await expectFail("zero amount",     { ...base, betAmount: "0" });
    await expectFail("round mismatch", {
      ...base,
      roundId: wrongRoundIdFromCurrent(roundId),
    });

    // --- Duplicate same-panel: second attempt should fail ---
    if (firstBetId) {
      total += 1;
      try {
        await placeBet(socket, types, { ...base, panel: "A" }, NEGATIVE_ACK_TIMEOUT_MS);
        console.log("[case duplicate same panel]", {
          firstBetId,
          pass: false,
          unexpected: "second bet did not fail",
        });
      } catch (err) {
        passed += 1;
        console.log("[case duplicate same panel]", { firstBetId, pass: true });
      }
    } else {
      console.log("[case duplicate same panel]", {
        skip: true,
        reason: "first bet failed, cannot test duplicate",
      });
    }

    console.log(`[result] ${passed}/${total} cases passed`);
    if (passed !== total) {
      throw new Error(`negative cases failed: ${passed}/${total}`);
    }
    console.log("[PASS] negative.js finished");
  } finally {
    socket.disconnect();
  }
})().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
