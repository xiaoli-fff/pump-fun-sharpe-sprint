# pump-fun-sharpe-sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/xiaoli-fff/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/xiaoli-fff/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-money trading bot for pump.fun bonding curves, entered in the make.fun Pump.fun Sharpe Sprint bounty. It is ranked on hourly Sharpe ratio over a 6-hour replay, not raw PnL, so it trades for steady, controlled gains: two tiers share one entry signal (a confirmed explosive cross of the real SOL reserve). Tier 1 buys the strict setup — real SOL first crossing 2 SOL, then at least doubling with at least 4 distinct non-creator buyers in the confirmation window — at full size with a 15% take-profit / 10% stop-loss. Tier 2 buys a looser setup (0.4 SOL cross, 2.4x growth, at least 3 buyers) at small size with a 5% take-profit / 10% stop-loss, so the entry clears the 20-distinct-mint guardrail in a 6-hour window and trades in hours where tier 1 finds nothing. Both tiers exit within 8 slots.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol over stdin/stdout (hello/batch/done) and trades paper SOL on the replayed market events.

---

<sub>Entered on [make.fun](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
