/**
 * Telegram Channel Message Parser (multi-format)
 * Handles: KOL APED, MULTIBUY, SWAP notifications
 */

/**
 * Parse market cap string like "$5.3K", "$1.2M", "$300" to USD number
 */
function parseMarketCap(mcStr) {
  if (!mcStr) return 0;
  const match = mcStr.match(/\$?([\d.]+)\s*([KMB])?/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const suffix = (match[2] || '').toUpperCase();
  const multipliers = { K: 1_000, M: 1_000_000, B: 1_000_000_000 };
  return num * (multipliers[suffix] || 1);
}

/**
 * Parse age string like "1m", "7m", "51.4h" to minutes
 */
function parseAgeMinutes(ageStr) {
  if (!ageStr) return 0;
  const match = ageStr.match(/([\d.]+)\s*([mh])/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  return match[2].toLowerCase() === 'h' ? val * 60 : val;
}

/**
 * Extract Solana mint address from text.
 * Priority: backticked pump > raw pump > backticked any > raw any
 * Supports any valid base58 Solana address (32-44 chars).
 */
function extractMint(text) {
  const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
  // Backticked pump address (highest confidence)
  const backtickPump = text.match(new RegExp('`(' + BASE58 + '{30,44}pump)`'));
  if (backtickPump) return backtickPump[1];

  // Raw pump address
  const rawPump = text.match(new RegExp('(?:^|[\\s:;,.])(' + BASE58 + '{30,44}pump)(?:$|[\\s:;,.])', 'm'));
  if (rawPump) return rawPump[1];

  // Backticked any Solana address (32-44 chars)
  const backtickAny = text.match(new RegExp('`(' + BASE58 + '{32,44})`'));
  if (backtickAny) return backtickAny[1];

  // Raw address — look near keywords like CA, contract, address, token, mint
  const withKeyword = text.match(new RegExp('(?:CA|contract|address|token|mint)[:\\s]*(' + BASE58 + '{32,44})', 'i'));
  if (withKeyword) return withKeyword[1];

  // Last resort: any standalone base58 32-44 char string (avoid URLs, hashes)
  const lines = text.split('\n');
  for (const line of lines) {
    // Skip lines that look like URLs or pure numbers
    if (/^https?:\/\//i.test(line.trim())) continue;
    const match = line.match(new RegExp('(?:^|[\\s:;,.])(' + BASE58 + '{32,44})(?:$|[\\s:;,.])'));
    if (match) return match[1];
  }

  return null;
}

/**
 * Parse KOL APED format:
 * 👑 **KOL APED NEW · #COACH**
 * 💰 MC: $5.3K   ⏳ 1m
 * 🗣 Putrick
 * Top10 21% · Mint✅ · Freeze✅
 * `CKhaTg...pump`
 */
function parseKolAped(text) {
  // Format detection: require KOL/APED markers
  if (!/KOL|APED/i.test(text)) return null;

  const mint = extractMint(text);
  if (!mint) return null;

  const clean = text.replace(/\*\*/g, '');

  // Symbol from #TAG or · NAME
  const symbolMatch = clean.match(/#\s*(\S+)/);
  const symbol = symbolMatch?.[1]?.replace(/[^A-Za-z0-9]/g, '') || null;

  // MC
  const mcMatch = clean.match(/MC:\s*\$?([\d.]+\s*[KMB]?)/i);
  const marketCapUsd = parseMarketCap(mcMatch?.[1]);

  // KOL
  const kolMatch = clean.match(/🗣\s*(.+?)(?:\n|$)/);
  const kol = kolMatch?.[1]?.trim() || null;

  // Top10
  const top10Match = clean.match(/Top10\s*([\d.]+)%/);
  const top10Percent = top10Match ? parseFloat(top10Match[1]) : null;

  // Age
  const ageMatch = clean.match(/⏳\s*([\d.]+[mh])/i);
  const ageMinutes = parseAgeMinutes(ageMatch?.[1]);

  // Mint/Freeze status (✅ or ✅)
  const mintLocked = /Mint\s*✅/.test(clean);
  const freezeLocked = /Freeze\s*✅/.test(clean);

  return {
    mint,
    symbol,
    marketCapUsd,
    kol,
    top10Percent,
    ageMinutes,
    mintLocked,
    freezeLocked,
    title: clean.split('\n')[0]?.trim() || '',
    format: 'kol_aped',
  };
}

/**
 * Parse MULTIBUY format:
 * 🟢 **MULTIBUY (18)** · **$Jotchua** · SOL
 * 💰 MC: $5.10M
 * 💧 LIQ: $258.9K   📈 Vol24h: $6.22M
 * 👥 Holders: 2508   ⏳ Age: 51.4h
 * 🛡 ✅ Mint off   ✅ Freeze off
 */
function parseMultiBuy(text) {
  // Format detection: require MULTIBUY marker
  if (!/MULTIBUY/i.test(text)) return null;

  const mint = extractMint(text);
  // MULTIBUY may not have mint in text — skip if no mint
  if (!mint) return null;

  const clean = text.replace(/\*\*/g, '');

  // Symbol from $NAME or #NAME
  const symbolMatch = clean.match(/[\$#]\s*(\S+)/);
  const symbol = symbolMatch?.[1]?.replace(/[^A-Za-z0-9]/g, '') || null;

  // MC
  const mcMatch = clean.match(/MC:\s*\$?([\d.]+\s*[KMB]?)/i);
  const marketCapUsd = parseMarketCap(mcMatch?.[1]);

  // Holders
  const holdersMatch = clean.match(/Holders:\s*([\d,]+)/);
  const holders = holdersMatch ? parseInt(holdersMatch[1].replace(/,/g, ''), 10) : null;

  // Age
  const ageMatch = clean.match(/Age:\s*([\d.]+[mh])/i);
  const ageMinutes = parseAgeMinutes(ageMatch?.[1]);

  // Mint/Freeze status (MULTIBUY uses "Mint off" = locked, "Mint on" = unlocked)
  const mintLocked = /Mint\s*off/i.test(clean) || /Mint\s*✅/.test(clean);
  const freezeLocked = /Freeze\s*off/i.test(clean) || /Freeze\s*✅/.test(clean);

  // Multi-buy count
  const multiMatch = clean.match(/MULTIBUY\s*\((\d+)\)/);
  const buyCount = multiMatch ? parseInt(multiMatch[1], 10) : null;

  return {
    mint,
    symbol,
    marketCapUsd,
    kol: null,
    top10Percent: null,
    ageMinutes,
    mintLocked,
    freezeLocked,
    holders,
    buyCount,
    title: clean.split('\n')[0]?.trim() || '',
    format: 'multi_buy',
  };
}

/**
 * Parse SWAP format:
 * ⭐️ 🟢 Swapped 3.01 #SOL ($199.18) for 199.92 #USDC On Raydium @ $1 | MC: $7.9k | Age: 2064d
 * or:
 * 🟢 BUY Jotchua on PumpSwap • 0.42 SOL
 * #disc_trending_7d_26 swapped 198.81 ($198.77) USDC for 38,777.18 ($198.81) Jotchua @$0.00512
 * 💊 #Jotchua | Jotchua (X | WEB) | MC: $5.13M | LQ: $129.83K |
 */
function parseSwap(text) {
  // Format detection: require swap/trade markers
  // [Bb]uy.+\\bon\\b avoids false positive from "MOON" matching "on" case-insensitive
  if (!/[Ss]wap|[Ss]wapped|PumpSwap|Raydium|[Bb]uy.+\\bon\\b/i.test(text)) return null;

  const mint = extractMint(text);
  if (!mint) return null;

  const clean = text.replace(/\*\*/g, '');

  // Symbol from #NAME
  const symbolMatch = clean.match(/#\s*(\S+)/);
  const symbol = symbolMatch?.[1]?.replace(/[^A-Za-z0-9]/g, '') || null;

  // MC (may have various formats)
  const mcMatch = clean.match(/MC[:\s]*\$?([\d.]+\s*[KMB]?)/i);
  const marketCapUsd = parseMarketCap(mcMatch?.[1]);

  // Age (may be "Age: 2064d" — convert days to minutes)
  const ageMatch = clean.match(/Age:\s*([\d.]+)([mhd])/i);
  let ageMinutes = 0;
  if (ageMatch) {
    const val = parseFloat(ageMatch[1]);
    const unit = ageMatch[2].toLowerCase();
    ageMinutes = unit === 'h' ? val * 60 : unit === 'd' ? val * 1440 : val;
  }

  return {
    mint,
    symbol,
    marketCapUsd,
    kol: null,
    top10Percent: null,
    ageMinutes,
    mintLocked: false,
    freezeLocked: false,
    title: clean.split('\n')[0]?.trim() || '',
    format: 'swap',
  };
}

/**
 * Generic fallback parser — extracts whatever metadata is available.
 * Handles: "BUY $TOKEN CA: xxx", "snipe xxxpump", raw CA dumps, etc.
 * Last resort when no structured format matches.
 */
function parseGeneric(text) {
  const mint = extractMint(text);
  if (!mint) return null;

  const clean = text.replace(/\*\*/g, '').replace(/[`]/g, '');

  // Symbol: $TOKEN, #TOKEN, or near "ticker/symbol" keywords
  let symbol = null;
  const symbolMatch = clean.match(/[$#]\s*([A-Za-z0-9_]{2,15})\b/);
  if (symbolMatch) {
    symbol = symbolMatch[1].replace(/[^A-Za-z0-9]/g, '');
  }

  // Market cap — broad patterns
  const mcPatterns = [
    /MC[:\s]*\$?([\d.,]+\s*[KMB]?)/i,
    /market\s*cap[:\s]*\$?([\d.,]+\s*[KMB]?)/i,
    /mcap[:\s]*\$?([\d.,]+\s*[KMB]?)/i,
    /\$([\d.,]+\s*[KMB])\b/i,  // standalone $5.3K
  ];
  let marketCapUsd = 0;
  for (const pat of mcPatterns) {
    const m = clean.match(pat);
    if (m) {
      marketCapUsd = parseMarketCap(m[1]);
      if (marketCapUsd > 0) break;
    }
  }

  // Age — patterns like "5m", "2h", "Age: 5m", "age 3 hours"
  const agePatterns = [
    /Age[:\s]*([\d.]+)\s*([mhd])/i,
    /age[:\s]*([\d.]+)\s*(min|hour|day)/i,
    /([\d.]+)\s*([mhd])\s*old/i,
    /(?:^|\s)([\d.]+)\s*([mh])\b/im,  // standalone "5m" or "2h" at line start
  ];
  let ageMinutes = 0;
  for (const pat of agePatterns) {
    const m = clean.match(pat);
    if (m) {
      const val = parseFloat(m[1]);
      let unit = m[2].toLowerCase();
      if (unit === 'min') unit = 'm';
      else if (unit === 'hour' || unit === 'hours') unit = 'h';
      else if (unit === 'day' || unit === 'days') unit = 'd';
      ageMinutes = unit === 'h' ? val * 60 : unit === 'd' ? val * 1440 : val;
      break;
    }
  }

  // Holders
  const holdersMatch = clean.match(/holders?[:\s]*([\d,.]+)/i);
  const holders = holdersMatch ? parseInt(holdersMatch[1].replace(/[,]/g, ''), 10) : null;

  // Top10 concentration
  const top10Match = clean.match(/top\s*10[:\s]*([\d.]+)%/i) || clean.match(/([\d.]+)%\s*top/i);
  const top10Percent = top10Match ? parseFloat(top10Match[1]) : null;

  // Liquidity
  const liqMatch = clean.match(/liq[:\s]*\$?([\d.,]+\s*[KMB]?)/i);
  const liquidityUsd = liqMatch ? parseMarketCap(liqMatch[1]) : 0;

  // Volume
  const volMatch = clean.match(/vol(?:24h)?[:\s]*\$?([\d.,]+\s*[KMB]?)/i);
  const volumeUsd = volMatch ? parseMarketCap(volMatch[1]) : 0;

  // Mint/Freeze status — broad detection (handle "Mint: locked", "Mint off", "Mint✅")
  const mintLocked = /mint[:\s]*(off|locked|✅)/i.test(clean);
  const freezeLocked = /freeze[:\s]*(off|locked|✅)/i.test(clean);

  // Confidence score (how much metadata we extracted)
  const fieldsFound = [
    symbol, marketCapUsd > 0, ageMinutes > 0, holders, top10Percent, liquidityUsd > 0,
  ].filter(Boolean).length;

  return {
    mint,
    symbol,
    marketCapUsd,
    kol: null,
    top10Percent,
    ageMinutes,
    mintLocked,
    freezeLocked,
    holders,
    liquidityUsd,
    volumeUsd,
    title: clean.split('\n')[0]?.trim()?.slice(0, 80) || '',
    format: 'generic',
    confidence: fieldsFound, // 0-6: how much metadata was found
  };
}

/**
 * Parse a channel message (tries all formats, generic as last resort)
 * @param {string} text - Raw message text
 * @returns {object|null} Parsed signal or null if not parseable
 */
export function parseChannelMessage(text) {
  if (!text || typeof text !== 'string') return null;

  // Try specific formats first (more reliable metadata)
  return parseKolAped(text) || parseMultiBuy(text) || parseSwap(text) || parseGeneric(text);
}

/**
 * Validate if signal meets minimum quality thresholds
 */
export function signalQualityCheck(signal, thresholds = {}) {
  const {
    minMarketCapUsd = 0,
    maxMarketCapUsd = 200_000,
    maxTop10Percent = 40,
    requireMintLocked = true,
    requireFreezeLocked = false,
  } = thresholds;

  if (!signal?.mint) return { pass: false, reason: 'no_mint' };
  if (signal.marketCapUsd < minMarketCapUsd) return { pass: false, reason: 'mcap_too_low' };
  if (signal.marketCapUsd > maxMarketCapUsd) return { pass: false, reason: 'mcap_too_high' };
  if (maxTop10Percent > 0 && signal.top10Percent && signal.top10Percent > maxTop10Percent) {
    return { pass: false, reason: 'top10_concentration' };
  }
  // Relax mint/freeze check for non-KOL formats (swap/multibuy/generic may not have this info)
  if (requireMintLocked && signal.format === 'kol_aped' && !signal.mintLocked) {
    return { pass: false, reason: 'mint_not_locked' };
  }
  if (requireFreezeLocked && signal.format === 'kol_aped' && !signal.freezeLocked) {
    return { pass: false, reason: 'freeze_not_locked' };
  }

  return { pass: true, reason: null };
}
