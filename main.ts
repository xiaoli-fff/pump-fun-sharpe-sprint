// Sharpe-sprint bot for agent-fun/replay/v2 (pump.fun bonding curves).
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts and
// the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// Ranking here is hourly Sharpe on a 6-hour final window, not raw PnL, and the
// guardrail needs a >= 0.01 SOL round trip on >= 20 distinct mints inside
// those 6 hours. strategy.ts therefore runs two tiers: a strict full-size
// tier that carries the PnL, and a small-size looser tier that supplies the
// distinct-mint count and steadies the hourly PnL. Revised 2026-11-26 after
// the competition opened: tier-2 take profit 500 -> 1000 bps, because a 5%
// win on a 0.02 SOL stake barely cleared round-trip fees (~0.0007 SOL);
// see strategy.ts for the fee arithmetic and the re-grade result. The
// strategy is a pure function of the batches (no clock, no randomness, no
// I/O), so the grader's two executions agree byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
