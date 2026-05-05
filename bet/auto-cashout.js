/**
 * Auto cashout: place a bet with autoCashoutAt set, wait for RUNNING,
 * then wait for server:player:cashout push confirming the server triggered it automatically.
 * Not included in test:all by default (timing-sensitive; requires a running round).
 */
const { BASE_BET_PAYLOAD, validateRequiredConfig } = require("../config/config");
const {
  loadProtoTypes,
  buildSocket,
  waitConnected,
  enterGame,
  waitForBettingPhase,
  waitForRunningPhase,
  placeBet,
  snapshotPhase,
  snapshotRoundId,
  enterGameAckLogFields,
  betIdStringFromPlaceBetRet,
} = require("../helpers/cgSocketHelpers");
const { toBuf } = require("../helpers/commons");

// The multiplier at which the server should auto-cash out.
const AUTO_CASHOUT_AT = process.env.CG02_AUTO_CASHOUT_AT_TEST || "1.20";

// Payout is async: push arrives after PayoutCompletedEvent (not when server logs [auto-cashout] triggered).
const WAIT_AUTO_CASHOUT_MS = Number(process.env.CG02_WAIT_AUTO_CASHOUT_MS || 30000);

function betIdKey(v) {
  if (v == null || v === "") return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object" && v != null && typeof v.toString === "function") {
    return v.toString();
  }
  return String(v);
}

/**
 * Subscribe after placeBet; call armTimeout(ms) after RUNNING so pushes during the round are not missed.
 */
function createCashoutWait(socket, types, wantBetIdStr) {
  let deadline = null;
  let settled = false;
  let rejectFn;
  let onCashout;

  const promise = new Promise((resolve, reject) => {
    rejectFn = reject;

    onCashout = (data) => {
      if (settled) return;
      try {
        const envelope = types.ServerCashout.decode(toBuf(data));
        const decoded = envelope.detail;
        if (!decoded) return;
        const obj = types.TransactionDetail.toObject(decoded, {
          longs: String,
          defaults: true,
        });
        const id =
          obj.betId != null && obj.betId !== ""
            ? String(obj.betId)
            : betIdKey(decoded.betId);
        if (id === wantBetIdStr) {
          settled = true;
          if (deadline) clearTimeout(deadline);
          socket.off("server:player:cashout", onCashout);
          resolve(decoded);
        }
      } catch (e) {
        console.warn("[step5] server:player:cashout handler error:", e.message);
      }
    };

    socket.on("server:player:cashout", onCashout);
  });

  function armTimeout(timeoutMs) {
    if (deadline) clearTimeout(deadline);
    deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.off("server:player:cashout", onCashout);
      rejectFn(
        new Error(
          `Auto cashout not received within ${timeoutMs}ms for betId=${wantBetIdStr}`
        )
      );
    }, timeoutMs);
  }

  return { promise, armTimeout };
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
    const snapBetting = await waitForBettingPhase(socket, types, roomId);
    const roundId = snapshotRoundId(snapBetting);
    console.log("[step2 ack]", { phase: snapshotPhase(snapBetting), roundId });

    console.log(
      `[step3] place bet with autoCashoutAt=${AUTO_CASHOUT_AT} panel=A`
    );
    const betRet = await placeBet(socket, types, {
      ...BASE_BET_PAYLOAD,
      roomId,
      roundId,
      panel: "A",
      cashoutType: "AUTO",
      autoCashoutAt: AUTO_CASHOUT_AT,
    });
    const betIdStr = betIdStringFromPlaceBetRet(betRet, types);
    console.log("[step3 ack]", { betId: betIdStr });
    if (!betIdStr) {
      throw new Error("Place bet failed: no betId returned");
    }

    const { promise: cashoutPromise, armTimeout } = createCashoutWait(
      socket,
      types,
      betIdStr
    );

    console.log("[step4] wait RUNNING for same round (cashout listener already on)");
    await waitForRunningPhase(socket, types, roomId, roundId);
    console.log("[step4 ok] phase=RUNNING");

    console.log(
      `[step5] waiting for server:player:cashout (threshold=${AUTO_CASHOUT_AT})…`
    );
    armTimeout(WAIT_AUTO_CASHOUT_MS);
    const detail = await cashoutPromise;
    console.log("[step5 ok] server:player:cashout received", {
      betId: betIdKey(detail.betId),
      payoutAmount: detail.payoutAmount,
      multiplier: detail.multiplier,
      cashoutType: detail.cashoutType,
      isSuccess: detail.isSuccess,
    });

    if (!detail.isSuccess) {
      throw new Error("Auto cashout completed but isSuccess=false");
    }

    const receivedMultiplier = parseFloat(detail.multiplier || "0");
    const expectedThreshold = parseFloat(AUTO_CASHOUT_AT);
    if (receivedMultiplier < expectedThreshold) {
      throw new Error(
        `Auto cashout multiplier ${receivedMultiplier} is below threshold ${expectedThreshold}`
      );
    }

    console.log("[PASS] auto-cashout.js finished");
  } finally {
    socket.disconnect();
  }
})().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
