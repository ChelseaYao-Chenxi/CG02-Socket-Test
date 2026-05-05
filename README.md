# CG02 Socket Test

## Structure

```text
CG02-socket-test/
  config/
    config.js
    secrets.js
  helpers/
    commons.js
    cgSocketHelpers.js
  proto/
    client.proto
    server.proto
  bet/
    success.js
    success-a.js
    negative.js
    combined-limit.js
    half-cashout.js
    auto-cashout.js
  scripts/
    test-all.js
```

## Install

```bash
npm install
```

## Setup `.env`

```bash
cp .env.example .env
```

## Required env key

```bash
CG02_ACCESS_TOKEN=your-token
```

## npm commands 

| Command | What it runs | Notes |
|--------|----------------|--------|
| `npm run bet:success` | `bet/success.js` | Happy path: enter → wait `BETTING` → place bet using `BASE_BET_PAYLOAD` / `.env` panel & amount. |
| `npm run bet:success-a` | `bet/success-a.js` | Same as success but **panel A**; amount from `CG02_SUCCESS_A_AMOUNT` or `CG02_BET_AMOUNT`. |
| `npm run bet:negative` | `bet/negative.js` | Invalid panel, zero amount, round mismatch, duplicate same-panel bet. |
| `npm run bet:combined-limit` | `bet/combined-limit.js` | Proves **A+B combined cap**: needs chip amounts in env **and** `CG02_COMBINED_MAX` (and server `bet.max-combined-amount`) low enough that two max chips can exceed the cap. |
| `npm run bet:half-cashout` | `bet/half-cashout.js` | **MANUAL** bet → wait **RUNNING** → `cashoutType: HALF`. Timing-sensitive; not in `test:all`. |
| `npm run bet:auto-cashout` | `bet/auto-cashout.js` | **AUTO** bet with `autoCashoutAt` threshold → wait **RUNNING** → server triggers cashout automatically → asserts `server:player:cashout` push with `isSuccess=true`. Timing-sensitive; not in `test:all`. |

### Combined-limit env tuning

Use chip denominations your socket allows (e.g. `0.5,1,2.5,5,8,15`). Example:

```bash
CG02_COMBINED_MAX=25
CG02_COMBINED_AMOUNT_A_CANDIDATES=15,8,5,2.5,1,0.5
CG02_COMBINED_AMOUNT_B_CANDIDATES=15,8,5,2.5,1,0.5
```

### Half-cashout env

- `CG02_WAIT_RUNNING_TIMEOUT_MS` — max wait to enter `RUNNING` for the same round (default in `config.js`).
- Bet must be **MANUAL** with no auto cashout (the script forces this for step 3).

### Auto-cashout env

- `CG02_AUTO_CASHOUT_AT_TEST` — multiplier threshold at which the server should auto-cash out (default `1.50`). Must be reachable: the game curve hits `1.50x` at ~2.5s into RUNNING. If the round’s crash point is **below** this value, no auto cashout will occur (expected).
- `CG02_WAIT_AUTO_CASHOUT_MS` — max wait for `server:player:cashout` after RUNNING (default `30000`ms; payout is async after `[auto-cashout] triggered`).
