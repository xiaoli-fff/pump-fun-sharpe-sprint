// main.ts — entrypoint for the pump.fun Sharpe sprint bot.
//
// The strategy lives in strategy.ts; this file only builds it with the
// default parameters and hands it to the SDK's runBot, which owns the wire:
// one hello, one batch at a time, one reply per batch, then done. The bot
// itself is a pure function of the batches it has seen — no clock, no
// randomness, no I/O — so the same replay always yields the same orders.
// Buys chase a reserve crossing in a one-to-three-slot window, in a strict
// 0.2 SOL tier first and a loose 0.02 SOL tier second; sells are mechanical
// take-profit, stop-loss, trailing, holding-cap or creator-sold exits.

import { runBot } from "./vendor/makefun-bot.ts";
import type { Bot } from "./vendor/makefun-bot.ts";
import { createPumpFunStrategy, DEFAULT_PARAMS } from "./strategy.ts";

const strategy = createPumpFunStrategy(DEFAULT_PARAMS);

// One handler object, so the wiring stays visible: the strategy decides
// every batch, and runBot speaks the protocol around it.
const bot: Bot = {
  onBatch: (state, batch) => strategy.onBatch(state, batch),
};

await runBot(bot);
