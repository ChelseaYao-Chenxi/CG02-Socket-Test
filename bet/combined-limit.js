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

const PANEL_A = process.env.CG02_COMBINED_PANEL_A || "A";
const PANEL_B = PANEL_A === "A" ? "B" : "A";

const AMOUNT_A_CANDIDATES = (
  process.env.CG02_COMBINED_AMOUNT_A_CANDIDATES ||
  "100,90,80,75,60"
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const AMOUNT_B_CANDIDATES = (
  process.env.CG02_COMBINED_AMOUNT_B_CANDIDATES ||
  "100,90,80,75,60,50"
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const COMBINED_MAX = Number(process.env.CG02_COMBINED_MAX || "150");

function toNumber(value) {
  return Number(String(value));
}

// Returns { success: bool, betId: string }
async function placeBetProbe(socket, types, payload, label) {
  try {
    const ret = await placeBet(socket, types, payload);
    const betId = betIdStringFromPlaceBetRet(ret, types);
    console.log(`[${label}]`, { betId });
    return { success: !!betId && betId !== "0", betId };
  } catch (err) {
    console.log(`[${label}]`, { success: false, error: err.message });
    return { success: false, betId: "" };
  }
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
    console.log("[step1 ack]", {
      roomId,
      currentCount,
    });

    console.log("[step2] wait betting phase");
    const snapshot = await waitForBettingPhase(socket, types, roomId);
    const roundId = snapshotRoundId(snapshot);
    console.log("[step2 ack]", { phase: snapshotPhase(snapshot), roundId });

    const base = {
      ...BASE_BET_PAYLOAD,
      roomId,
      roundId,
    };

    // Pick an A amount that is accepted by chips config and single-limit checks.
    let firstAmount = null;
    let firstBetId = "";
    for (const amount of AMOUNT_A_CANDIDATES) {
      const result = await placeBetProbe(
        socket,
        types,
        { ...base, panel: PANEL_A, betAmount: amount },
        `probe panel ${PANEL_A} amount ${amount}`
      );
      if (result.success) {
        firstAmount = amount;
        firstBetId = result.betId;
        break;
      }
    }

    if (!firstBetId) {
      throw new Error(
        `No valid first amount found for panel ${PANEL_A}; ` +
          "adjust CG02_COMBINED_AMOUNT_A_CANDIDATES to your chips config"
      );
    }

    console.log("[step3] first panel bet success", {
      panel: PANEL_A,
      amount: firstAmount,
      betId: firstBetId,
    });

    const firstNum = toNumber(firstAmount);
    const maxBCandidate = Math.max(
      ...AMOUNT_B_CANDIDATES.map((x) => toNumber(x)).filter((n) => !Number.isNaN(n)),
      -Infinity
    );
    if (!Number.isFinite(maxBCandidate) || maxBCandidate < 0) {
      throw new Error(
        "CG02_COMBINED_AMOUNT_B_CANDIDATES has no numeric amounts; fix your env."
      );
    }
    if (firstNum + maxBCandidate <= COMBINED_MAX) {
      throw new Error(
        `Cannot test combined A+B limit: largest try would be ${PANEL_A} ${firstNum} + ${PANEL_B} ${maxBCandidate} = ${firstNum + maxBCandidate}, ` +
          `which is not greater than CG02_COMBINED_MAX (${COMBINED_MAX}). ` +
          `Lower CG02_COMBINED_MAX so that (first panel amount + some chip on the other panel) can exceed it ` +
          `(e.g. CG02_COMBINED_MAX=25 when max chip is 15).`
      );
    }

    let validated = false;
    for (const amountB of AMOUNT_B_CANDIDATES) {
      const secondNum = toNumber(amountB);
      if (Number.isNaN(secondNum)) continue;
      if (firstNum + secondNum <= COMBINED_MAX) continue;

      // Server should throw (combined limit exceeded) → placeBet rejects
      let isCombinedError = false;
      try {
        const second = await placeBet(
          socket,
          types,
          { ...base, panel: PANEL_B, betAmount: amountB },
          NEGATIVE_ACK_TIMEOUT_MS
        );
        console.log(`[step4] second panel ${PANEL_B} amount ${amountB}`, {
          betId: betIdStringFromPlaceBetRet(second, types),
          expectedCombinedLimit: true,
          pass: false,
        });
      } catch (err) {
        isCombinedError = true;
        console.log(`[step4] second panel ${PANEL_B} amount ${amountB}`, {
          expectedCombinedLimit: true,
          pass: true,
          error: err.message,
        });
      }

      if (isCombinedError) {
        validated = true;
        break;
      }
    }

    if (!validated) {
      throw new Error(
        "Could not validate combined A+B limit: server did not reject any over-limit B amount. " +
          "Check chip list vs CG02_COMBINED_AMOUNT_B_CANDIDATES or lower CG02_COMBINED_MAX."
      );
    }

    console.log("[PASS] combined-limit.js finished");
  } finally {
    socket.disconnect();
  }
})().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
