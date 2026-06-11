import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelMessage, signalQualityCheck } from '../src/signals/telegramParser.js';

// Test mint addresses
const PUMP_MINT = 'CKhaTg7ZEMjQ7k7BqGMnBmpg7MnmBmpg7MnmBmpg7pump';
const RAYDIUM_MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

describe('telegramParser', () => {

  describe('extractMint', () => {
    it('extracts backticked pump address', () => {
      const text = `Token info\n\`${PUMP_MINT}\`\nMC: $5K`;
      const result = parseChannelMessage(text);
      assert.equal(result?.mint, PUMP_MINT);
    });

    it('extracts raw pump address', () => {
      const text = `BUY token ${PUMP_MINT} moon!`;
      const result = parseChannelMessage(text);
      assert.equal(result?.mint, PUMP_MINT);
    });

    it('extracts backticked non-pump address', () => {
      const text = `Check this out:\n\`${RAYDIUM_MINT}\`\nMC: $1.2M`;
      const result = parseChannelMessage(text);
      assert.equal(result?.mint, RAYDIUM_MINT);
    });

    it('extracts address near CA keyword', () => {
      const text = `New token!\nCA: ${RAYDIUM_MINT}\nBUY now`;
      const result = parseChannelMessage(text);
      assert.equal(result?.mint, RAYDIUM_MINT);
    });

    it('extracts address near contract keyword', () => {
      const text = `contract: ${RAYDIUM_MINT}`;
      const result = parseChannelMessage(text);
      assert.equal(result?.mint, RAYDIUM_MINT);
    });

    it('returns null for short strings', () => {
      const text = 'just some random text with no address';
      const result = parseChannelMessage(text);
      assert.equal(result, null);
    });

    it('skips URLs when searching for standalone address', () => {
      const text = `Check https://example.com/abc123def456abc123def456abc123def4\n${PUMP_MINT}`;
      const result = parseChannelMessage(text);
      assert.equal(result?.mint, PUMP_MINT);
    });
  });

  describe('KOL APED format', () => {
    const kolMessage = `👑 **KOL APED NEW · #COACH**\n💰 MC: $5.3K   ⏳ 1m\n🗣 Putrick\nTop10 21% · Mint✅ · Freeze✅\n\`${PUMP_MINT}\``;

    it('parses KOL APED correctly', () => {
      const result = parseChannelMessage(kolMessage);
      assert.ok(result);
      assert.equal(result.format, 'kol_aped');
      assert.equal(result.mint, PUMP_MINT);
      assert.equal(result.symbol, 'COACH');
      assert.equal(result.marketCapUsd, 5300);
      assert.equal(result.kol, 'Putrick');
      assert.equal(result.top10Percent, 21);
      assert.equal(result.ageMinutes, 1);
      assert.equal(result.mintLocked, true);
      assert.equal(result.freezeLocked, true);
    });
  });

  describe('MULTIBUY format', () => {
    const multiMessage = `🟢 **MULTIBUY (18)** · **$Jotchua** · SOL\n💰 MC: $5.10M\n💧 LIQ: $258.9K   📈 Vol24h: $6.22M\n👥 Holders: 2508   ⏳ Age: 51.4h\n🛡 ✅ Mint off   ✅ Freeze off\n\`${PUMP_MINT}\``;

    it('parses MULTIBUY correctly', () => {
      const result = parseChannelMessage(multiMessage);
      assert.ok(result);
      assert.equal(result.format, 'multi_buy');
      assert.equal(result.mint, PUMP_MINT);
      assert.equal(result.symbol, 'Jotchua');
      assert.equal(result.marketCapUsd, 5_100_000);
      assert.equal(result.holders, 2508);
      assert.equal(result.ageMinutes, 51.4 * 60);
      assert.equal(result.mintLocked, true);
      assert.equal(result.freezeLocked, true);
      assert.equal(result.buyCount, 18);
    });
  });

  describe('SWAP format', () => {
    it('parses swap with MC and age', () => {
      const swapMessage = `⭐️ 🟢 Swapped 3.01 #SOL ($199.18) for 199.92 #USDC On Raydium @ $1 | MC: $7.9k | Age: 2064d\n${PUMP_MINT}`;
      const result = parseChannelMessage(swapMessage);
      assert.ok(result);
      assert.equal(result.format, 'swap');
      assert.equal(result.mint, PUMP_MINT);
      assert.equal(result.marketCapUsd, 7900);
      assert.equal(result.ageMinutes, 2064 * 1440);
    });
  });

  describe('Generic fallback parser', () => {
    it('parses simple BUY message with CA', () => {
      const text = `BUY $MOON\nCA: ${PUMP_MINT}\nMC: $12K`;
      const result = parseChannelMessage(text);
      assert.ok(result);
      assert.equal(result.format, 'generic');
      assert.equal(result.mint, PUMP_MINT);
      assert.equal(result.symbol, 'MOON');
      assert.equal(result.marketCapUsd, 12000);
    });

    it('parses message with only CA (no metadata)', () => {
      const text = `snipe this\n${PUMP_MINT}`;
      const result = parseChannelMessage(text);
      assert.ok(result);
      assert.equal(result.format, 'generic');
      assert.equal(result.mint, PUMP_MINT);
      assert.equal(result.confidence, 0);
    });

    it('parses message with $TOKEN and CA', () => {
      const text = `$DOGE is mooning!\nContract: ${RAYDIUM_MINT}\nMC: $1.5M | Age: 3h | Holders: 5000`;
      const result = parseChannelMessage(text);
      assert.ok(result);
      assert.equal(result.format, 'generic');
      assert.equal(result.mint, RAYDIUM_MINT);
      assert.equal(result.symbol, 'DOGE');
      assert.equal(result.marketCapUsd, 1_500_000);
      assert.equal(result.ageMinutes, 180);
      assert.equal(result.holders, 5000);
    });

    it('parses message with #TOKEN format', () => {
      const text = `New call: #PEPE\n${PUMP_MINT}\nMC $500K`;
      const result = parseChannelMessage(text);
      assert.ok(result);
      assert.equal(result.symbol, 'PEPE');
      assert.equal(result.marketCapUsd, 500_000);
    });

    it('handles mcap keyword variations', () => {
      const text = `Token: $ABC\nmcap: $25K\n${PUMP_MINT}`;
      const result = parseChannelMessage(text);
      assert.ok(result);
      assert.equal(result.marketCapUsd, 25000);
    });

    it('handles market cap keyword', () => {
      const text = `market cap: $100K\n${PUMP_MINT}`;
      const result = parseChannelMessage(text);
      assert.ok(result);
      assert.equal(result.marketCapUsd, 100_000);
    });

    it('extracts liquidity and volume', () => {
      const text = `$TOKEN\n${PUMP_MINT}\nLiq: $50K | Vol24h: $200K`;
      const result = parseChannelMessage(text);
      assert.ok(result);
      assert.equal(result.liquidityUsd, 50_000);
      assert.equal(result.volumeUsd, 200_000);
    });

    it('extracts top10 concentration', () => {
      const text = `$TOKEN\n${PUMP_MINT}\nTop10: 35%`;
      const result = parseChannelMessage(text);
      assert.ok(result);
      assert.equal(result.top10Percent, 35);
    });

    it('detects mint locked status', () => {
      const text = `$TOKEN\n${PUMP_MINT}\nMint: locked | Freeze: locked`;
      const result = parseChannelMessage(text);
      assert.ok(result);
      assert.equal(result.mintLocked, true);
      assert.equal(result.freezeLocked, true);
    });

    it('non-pump Raydium address works as generic', () => {
      const text = `Graduated token!\n${RAYDIUM_MINT}\nMC: $500K`;
      const result = parseChannelMessage(text);
      assert.ok(result);
      assert.equal(result.format, 'generic');
      assert.equal(result.mint, RAYDIUM_MINT);
    });
  });

  describe('signalQualityCheck', () => {
    it('passes for valid generic signal with confidence', () => {
      const signal = {
        mint: PUMP_MINT,
        marketCapUsd: 50000,
        top10Percent: null,
        mintLocked: false,
        freezeLocked: false,
        format: 'generic',
        confidence: 3,
      };
      const result = signalQualityCheck(signal, {
        minGenericConfidence: 2,
      });
      assert.equal(result.pass, true);
    });

    it('fails for no mint', () => {
      const signal = { mint: null, marketCapUsd: 50000 };
      const result = signalQualityCheck(signal);
      assert.equal(result.pass, false);
      assert.equal(result.reason, 'no_mint');
    });

    it('fails for generic with low confidence', () => {
      const signal = { mint: PUMP_MINT, marketCapUsd: 0, format: 'generic', confidence: 0 };
      const result = signalQualityCheck(signal, { minGenericConfidence: 2 });
      assert.equal(result.pass, false);
      assert.match(result.reason, /generic_confidence_low/);
    });

    it('passes for non-generic format regardless of confidence', () => {
      const signal = { mint: PUMP_MINT, marketCapUsd: 0, format: 'kol_aped' };
      const result = signalQualityCheck(signal, { minGenericConfidence: 2 });
      assert.equal(result.pass, true);
    });

    it('passes for generic with sufficient confidence even if mcap is 0', () => {
      const signal = { mint: PUMP_MINT, marketCapUsd: 0, format: 'generic', confidence: 3 };
      const result = signalQualityCheck(signal, { minGenericConfidence: 2 });
      assert.equal(result.pass, true);
    });
  });
});
