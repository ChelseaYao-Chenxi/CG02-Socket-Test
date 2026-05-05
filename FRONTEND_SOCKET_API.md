# CG02 Socket API — Frontend Integration Reference

> Protocol: Socket.IO + Protobuf (binary)
> All payloads are serialized Protobuf messages.

---

## Client → Server Events

| Event | Payload | Notes |
|---|---|---|
| `client:game:enter` | `EnterGame` (empty) | ACK: `EnterGameRet { room_id, current_count }` |
| `client:room:snapshot` | `SnapshotReq { room_id }` | ACK: `Snapshot` (see structure below) |
| `client:bet:place` | `PlaceBet` | ACK: `PlaceBetRet { bet_id }` |
| `client:bet:cancel` | `CancelBet { round_id, room_id, bet_id }` | ACK: `CancelBetRet { status }` |
| `client:bet:cashout` | `CashoutReq { round_id, room_id, bet_id, cashout_type }` | ACK: `CashoutRet { status }` |
| `client:balance` | `Void` (empty) | Triggers `server:balance:changed` push |

### PlaceBet fields
```
bet_amount      string   e.g. "1.00"
currency        string   e.g. "USD"
round_id        int64
room_id         int64
cashoutType     string   "AUTO" | "MANUAL"
auto_cashout_at string   e.g. "2.00" (only when cashoutType = "AUTO")
panel           string   "A" | "B"   ← CG02 specific
```

### CashoutReq fields
```
round_id        int64
room_id         int64
bet_id          int64
cashout_type    string   "HALF" | "FULL"   ← CG02 specific (omit for standard full cashout)
```

---

## Server → Client Events

### `server:room:snapshot`
Sent once on `client:game:enter`, and as ACK for `client:room:snapshot`.

```json
{
  "roomId": 123456,
  "roundId": 789012,
  "room_phase": {
    "phase": "BETTING",
    "phase_end_at": { "seconds": 1777943346, "nanos": 0 },
    "round_id": 789012
  },
  "player_count": 5,
  "total_bet": "12.50",
  "leaderboard_snapshot": [
    { "user_name": "Alice", "bet_amount": "2.00" }
  ],
  "crash_point_history": ["2.34", "1.00", "5.67"],
  "panel_bet_details": [...],   // only present for the requesting user
  "game_status": {              // only present during RUNNING phase
    "multiplier": "1.42",
    "is_crash": false
  }
}
```

`panel_bet_details` per panel (CG02 specific):
```json
{
  "panel": "A",
  "bet_amount": "1.00",
  "bet_id": 177104241843990528,
  "is_cashout": false,
  "is_half_cashed_out": false,
  "remaining_bet_amount": "1.00",
  "half_cashout_payout": "",
  "cashout_type": "AUTO",
  "auto_cashout_at": "2.00"
}
```

---

### `server:room:game:phase`
Broadcast to entire room on every phase transition.

```json
{
  "phase": "RUNNING",
  "phase_end_at": { "seconds": 0, "nanos": 0 },
  "round_id": 789012
}
```

Phase values: `"BETTING"` → `"RUNNING"` → `"CASHOUT_GRACE"` → `"RESULT"` → (next `"BETTING"`)

---

### `server:room:game:status`
Broadcast to entire room every tick (~50ms) during RUNNING and CASHOUT_GRACE.

```json
{ "multiplier": "1.42", "is_crash": false }
```

- `is_crash: false` — game is running normally
- `is_crash: true` — game has crashed (phase is CASHOUT_GRACE or RESULT)

---

### `server:room:others`
Broadcast to entire room every **100ms**. Always contains current room state.
`items` is non-empty only in the flush after a bet or cashout occurs.

```json
{
  "player_count": 5,
  "total_bet": "12.50",
  "items": [[FRONTEND_SOCKET_API.md](FRONTEND_SOCKET_API.md)
    {
      "user_name": "Alice",
      "bet_amount": "1.00",
      "cashout_amount": "1.20",   // present only on cashout flush
      "panel": "A",
      "cashout_type": "AUTO"      // "AUTO" | "HALF" | "FULL"
    }
  ]
}
```

---

### `server:room:status`
Broadcast to entire room immediately after a bet is placed (in addition to the periodic `server:room:others`).

```json
{ "player_count": 5, "total_bet": "12.50" }
```

---

### `server:player:bet`
Sent to the betting player only after the wallet transaction completes.

```json
{
  "bet_amount": "1.00",
  "bet_id": 177104241843990528,
  "is_success": true
}
```

---

### `server:player:cashout`
Sent to the cashing-out player only. Payload is wrapped in a `detail` object.

```json
{
  "detail": {
    "bet_id": 177104241843990528,
    "payout_amount": "1.200000",
    "multiplier": "1.200000",
    "is_success": true,
    "cashout_type": "AUTO"
  }
}
```

---

### `server:balance:changed`
Sent to the individual player after any balance-changing event (bet, cashout, or `client:balance` query).

```json
{ "balance": "10000.20", "currency": "USD" }
```

---

### `server:alert`
Sent to the individual player on errors or warnings.

```json
{
  "code": "ROUND_MISMATCH",
  "message_en_US": "Round does not match",
  "message_zh_CN": "...",
  "message_zh_TW": "..."
}
```

---

## Round Lifecycle Timeline

```
BETTING phase starts
  ← server:room:game:phase        { phase: "BETTING", phase_end_at, round_id }
  ← server:room:others            every 100ms  { player_count, total_bet, items:[] }

Player enters room
  ← server:room:snapshot          (once, full state)

Player places bet
  ← server:player:bet             { bet_id, is_success: true }
  ← server:balance:changed        { balance }
  ← server:room:status            { player_count, total_bet }
  ← server:room:others            (next 100ms flush, items contains { user_name })

RUNNING phase starts
  ← server:room:game:phase        { phase: "RUNNING", round_id }
  ← server:room:game:status       every tick  { multiplier: "1.00", is_crash: false }
  ← server:room:others            every 100ms { player_count, total_bet }

Auto / manual cashout
  ← server:player:cashout         { detail: { bet_id, payout_amount, multiplier, cashout_type } }
  ← server:balance:changed        { balance }
  ← server:room:others            (next 100ms flush, items contains cashout info)

Game crashes → CASHOUT_GRACE
  ← server:room:game:phase        { phase: "CASHOUT_GRACE", phase_end_at, round_id }
  ← server:room:game:status       { multiplier: "2.34", is_crash: true }   ← is_crash flips here

RESULT phase
  ← server:room:game:phase        { phase: "RESULT", phase_end_at, round_id }

→ next BETTING begins, cycle repeats
```

---

## CG02-Specific Features

### Double Panel (A / B)
- Every bet must specify `panel: "A"` or `panel: "B"`
- Each panel is tracked independently in `panel_bet_details`
- A player can have active bets on both panels simultaneously

### Half Cashout
- Send `cashout_type: "HALF"` in `CashoutReq` to cash out half the bet
- After half cashout: `is_half_cashed_out: true`, `remaining_bet_amount` is halved
- The remaining half continues in the round and can be cashed out later with `cashout_type: "FULL"`
- `server:room:others` items will show `cashout_type: "HALF"` or `"FULL"` accordingly
