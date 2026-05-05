function emitWithAck(socket, eventName, payload, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      reject(
        new Error(`Ack timeout for ${eventName} after ${Date.now() - startedAt}ms`)
      );
    }, timeoutMs);

    try {
      socket.emit(eventName, payload, (ack) => {
        clearTimeout(timeout);
        resolve(ack);
      });
    } catch (err) {
      clearTimeout(timeout);
      reject(err);
    }
  });
}

function toBuf(value) {
  if (value == null) throw new Error("Empty payload");
  if (typeof value === "string") return Buffer.from(value, "base64");
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (Array.isArray(value)) return Buffer.from(value);
  if (value && value.type === "Buffer" && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  throw new Error(`Unknown payload type: ${Object.prototype.toString.call(value)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Avoid JS Number for protobuf int64 / Snowflake IDs (> 2^53). */
function int64ToDecimalString(v) {
  if (v == null || v === "") return "0";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object" && typeof v.toString === "function") {
    return v.toString();
  }
  return String(v);
}

module.exports = {
  emitWithAck,
  toBuf,
  sleep,
  int64ToDecimalString,
};
