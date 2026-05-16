# Charon Handbook

Panduan lengkap memahami Charon — Solana meme coin trading agent via Telegram.

---

## 1. Apa Itu Charon?

Charon adalah **Telegram trench agent** yang berfungsi:
- Memantau aliran token baru dari Pump.fun secara real-time
- Menyaring (screen) token-token berkualitas dari sinyal pasar yang berisik
- Mengambil keputusan beli menggunakan LLM (atau rule-based)
- Mengeksekusi perdagangan melalui Jupiter DEX (mode confirm atau live)
- Memantau posisi terbuka dan menjual otomatis saat TP/SL/trailing tercapai

Nama "Charon" berasal dari mitologi Yunani — pendayung yang menyeberangkan jiwa ke seberang sungai. Di sini, Charon menyeberangkan dari analisis mentah ke eksekusi perdagangan.

---

## 2. Glosarium Istilah

### Sinyal & Sumber Data

| Istilah | Penjelasan |
|---------|-----------|
| **Signal Server** | Server pihak ketiga (`api.thecharon.xyz`) yang mengumpulkan sinyal fee-claim, graduated, dan trending dari Pump.fun secara real-time |
| **Fee Claim** | Sinyal ketika fee distribusi token terdeteksi di blockchain — indikasi ada aktivitas jual/klaim dari pemegang awal |
| **Graduated** | Token yang sudah lulus dari bonding curve Pump.fun dan masuk ke Raydium (AMM publik) |
| **Trending** | Token yang masuk daftar trending di GMGN — diukur dari volume, jumlah swap, hot level, dan smart degen count |
| **Axiom Source** | Sumber data alternatif untuk sinyal (melalui `axiomSource.js`) |
| **Route** | Rute yang menghasilkan sinyal: `fee`, `graduated`, `trending`, atau kombinasinya (misal `fee_graduated`) |
| **Price Monitor** | Pemantau harga untuk alert dip buy — memeriksa alert harga yang disimpan user |

### Candidate & Pipeline

| Istilah | Penjelasan |
|---------|-----------|
| **Candidate** | Sebuah token yang terdeteksi dari sinyal, sudah di-enrich dengan data, dan siap disaring |
| **Enrichment** | Proses pengambilan data tambahan: GMGN (holder count, liquidity, fee, social links), Jupiter (asset info, holders, chart context), saved wallet exposure, Twitter narrative |
| **Filter** | Sekumpulan aturan berdasarkan strategi aktif. Jika gagal, candidate dibuang. Contoh: min market cap, min holder, max top holder %, min fee claim, dll |
| **Filter Failure** | Alasan kenapa candidate tidak lolos filter. Semua failure disimpan di SQLite |
| **Batch Decision** | LLM menerima hingga 10 candidate terbaru sekaligus dan memilih maksimal 1 untuk di-BUY |
| **Verdict** | Keputusan LLM: `BUY`, `WATCH`, atau `PASS` |
| **Confidence** | Skor keyakinan LLM (0-100), bukan probabilitas — ini level conviction |
| **Trigger Candidate** | Candidate yang memicu siklus batch (yang baru datang) |
| **Selected Candidate** | Candidate yang dipilih LLM untuk dibeli (bisa bukan trigger candidate) |

### Strategi

| Istilah | Penjelasan |
|---------|-----------|
| **Strategy** | Profil filter dan parameter trading yang bisa dipilih/disetting |
| **Sniper** | Strategi default: overlap fee-claim, entry immediate, LLM aktif |
| **Dip Buy** | Menunggu alert dip dari ATH-distance — beli saat pullback |
| **Smart Money** | Filter lebih ketat (holder/trending quality), support partial TP |
| **Degen** | Threshold sumber lebih rendah, rule-based (TANPA LLM, auto-approve) |
| **use_llm** | Flag strategi. `true` = panggil LLM, `false` = auto-approve kandidat yang lolos filter |
| **llm_min_confidence** | Ambang minimum confidence LLM (per-strategi, disimpan di SQLite) |

### Eksekusi

| Istilah | Penjelasan |
|---------|-----------|
| **TRADING_MODE** | Mode eksekusi: `dry_run`, `confirm`, atau `live` |
| **Dry Run** | Simulasi beli/jual, disimpan di SQLite. Tidak butuh wallet. Untuk testing |
| **Confirm** | Kirim trade intent ke Telegram dengan tombol Approve/Reject. Eksekusi live hanya setelah user klik Approve |
| **Live** | Tanda-tangani dan eksekusi Jupiter Ultra Swap langsung setelah approval strategi + LLM |
| **Trade Intent** | Intent perdagangan yang menunggu konfirmasi user (mode confirm) |
| **Jupiter Ultra** | Mode swap Jupiter yang menangani routing dan slippage otomatis |
| **LIVE_MIN_SOL_RESERVE** | Minimum SOL yang TIDAK boleh dipakai — safety buffer di wallet setelah pembelian |
| **Slippage BPS** | Basis point slippage (default 300 = 3%). Ditangani Jupiter Ultra |

### Posisi & Exit

| Istilah | Penjelasan |
|---------|-----------|
| **Position** | Posisi terbuka (beli) yang sedang dipantau |
| **High Water Mark** | Poin tertinggi market cap atau harga sejak posisi dibuka |
| **TP (Take Profit)** | Persentase profit untuk jual otomatis (misal 50%) |
| **SL (Stop Loss)** | Persentase loss untuk jual otomatis (misal -25%) |
| **Trailing TP** | Setelah TP tercapai, trailing aktif. Jual jika harga turun X% dari high water mark |
| **Trailing Armed** | Status trailing — baru aktif setelah TP initial tercapai |
| **Partial TP** | Jual sebagian posisi saat profit tertentu, sisanya tetap berjalan |
| **Max Hold** | Waktu maksimum posisi ditahan. Setelah itu, jual otomatis |
| **PnL Percent** | Persentase profit/loss dari entry market cap |
| **PnL SOL** | Absolute profit/loss dalam SOL |

### Storage & Infrastruktur

| Istilah | Penjelasan |
|---------|-----------|
| **charon.sqlite** | Database SQLite — sumber kebenaran utama |
| **Settings** | Konfigurasi disimpan di tabel `settings` (key-value). Bisa diubah via `/menu` atau `/stratset` tanpa restart |
| **Strategies Table** | Tabel strategi di SQLite — konfigurasi per-strategi termasuk TP, SL, trailing, dll |
| **Learning Runs** | Riwayat analisis belajar dari dry-run evidence |
| **Learning Lessons** | Pelajaran aktif yang dimasukkan ke prompt LLM untuk screening berikutnya |
| **Hot-Read** | Settings SQLite dibaca setiap kali diperlukan, tidak perlu restart. Berbeda dengan `.env` yang butuh restart |

---

## 3. Arsitektur & Aliran Data

```
Signal Server ──┐
Graduated Poll ─┤
Trending Poll ──┤
Fee Claim WS ───┤  →  Orchestrator  →  Candidate Builder  →  Filter
Price Alert ────┤        │                  │                    │
                 │        │                  │                    │
                 │        │                  ▼                    ├─── PASS → skip
                 │        │            Enrichment                 │
                 │        │        (GMGN, Jupiter,                ├─── WATCH → catat keputusan
                 │        │         Wallets, Twitter)             │
                 │        │                  │                    └─── BUY → lanjut ke eksekusi
                 │        │                  ▼
                 │        │            LLM Batch Decision
                 │        │                  │
                 │        │                  ▼
                 │        │          Trade Execution
                 │        │        ┌─────────────────────┐
                 │        └────────┤ dry_run / confirm /  │
                 │                 │      live             │
                 │                 └─────────────────────┘
                 │
                 └───── Position Monitor (setiap POSITION_CHECK_MS)
                           │
                           ├── TP → jual
                           ├── SL → jual
                           ├── Trailing → jual
                           ├── Partial TP → jual sebagian
                           └── Max Hold → jual
```

---

## 4. Konfigurasi `.env`

### Wajib

```
TELEGRAM_BOT_TOKEN=<token bot>
TELEGRAM_CHAT_ID=<chat ID / group ID>
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=<key dari maintainer>
```

### RPC & Eksekusi (untuk mode confirm/live)

```
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SOLANA_PRIVATE_KEY=<base58 private key wallet>
JUPITER_API_KEY=<kunci Jupiter>
JUPITER_SWAP_BASE_URL=https://api.jup.ag/swap/v2
LIVE_MIN_SOL_RESERVE=0.02
TRADING_MODE=dry_run  # atau: confirm, live
```

### LLM

```
ENABLE_LLM=true
LLM_BASE_URL=https://api.minimax.io/v1
LLM_API_KEY=<kunci LLM>
LLM_MODEL=MiniMax-M2.7
LLM_TIMEOUT_MS=120000
LLM_MAX_TOKENS=3000
LLM_CANDIDATE_PICK_COUNT=10
LLM_CANDIDATE_MAX_AGE_MS=600000
```

### GMGN

```
GMGN_ENABLED=true
GMGN_API_KEY=<kunci GMGN>
GMGN_REQUEST_DELAY_MS=2500
```

### Polling Intervals

```
SIGNAL_POLL_MS=30000          # Poll signal server setiap 30 detik
GRADUATED_POLL_MS=30000       # Poll graduated setiap 30 detik
TRENDING_POLL_MS=60000        # Poll trending setiap 60 detik
POSITION_CHECK_MS=10000       # Cek posisi setiap 10 detik
```

---

## 5. Strategi — Setting Lengkap

Setiap strategi punya parameter ini (contoh default **sniper**):

| Setting | Default | Keterangan |
|---------|---------|-----------|
| `entry_mode` | `immediate` | Mode entry: `immediate` untuk sniper |
| `min_source_count` | `2` | Minimal jumlah sinyal overlap (fee+graduated, dll) |
| `require_fee_claim` | `true` | Harus ada fee claim signal |
| `token_age_max_ms` | `3600000` | Maksimal umur token (1 jam = 3.6jt ms) |
| `min_mcap_usd` | `7000` | Market cap minimum |
| `max_mcap_usd` | `200000` | Market cap maksimum |
| `min_fee_claim_sol` | `0.5` | Minimal fee claim dalam SOL |
| `min_gmgn_total_fee_sol` | `10` | Minimal total fee di GMGN |
| `min_holders` | `0` | Minimal jumlah holder |
| `max_top20_holder_percent` | `100` | Maksimal konsentrasi top 20 holder (%) |
| `min_saved_wallet_holders` | `0` | Minimal holder dari saved wallet |
| `max_ath_distance_pct` | `0` | Maksimal jarak dari ATH (untuk dip buy, gunakan negatif) |
| `min_graduated_volume_usd` | `0` | Minimal volume graduated |
| `trending_min_volume_usd` | `0` | Minimal trending volume |
| `trending_min_swaps` | `0` | Minimal trending swaps |
| `trending_max_rug_ratio` | `0.3` | Maksimal rug ratio di trending |
| `trending_max_bundler_rate` | `0.5` | Maksimal bundler rate di trending |
| `position_size_sol` | `0.1` | Ukuran posisi per beli (SOL) |
| `max_open_positions` | `3` | Maksimal posisi terbuka bersamaan |
| `tp_percent` | `50` | Take profit (%) |
| `sl_percent` | `-25` | Stop loss (%) |
| `trailing_enabled` | `true` | Enable trailing stop |
| `trailing_percent` | `20` | Trailing drop (%) |
| `partial_tp` | `false` | Enable partial take profit |
| `partial_tp_at_percent` | `0` | Profit % untuk trigger partial TP |
| `partial_tp_sell_percent` | `0` | % yang dijual saat partial TP |
| `max_hold_ms` | `0` | Maksimal waktu hold (0 = unlimited) |
| `use_llm` | `true` | Pakai LLM untuk screening |
| `llm_min_confidence` | `50` | Minimum confidence LLM |

---

## 6. Telegram Commands

```
/menu                    → Menu interaktif (ganti strategi, setting, dll)
/strategy                → Lihat strategi aktif
/strategy sniper         → Ganti ke strategi sniper
/strategy dip_buy        → Ganti ke strategi dip_buy
/strategy smart_money    → Ganti ke strategi smart_money
/strategy degen          → Ganti ke strategi degen
/stratset sniper tp_percent 75        → Ubah setting strategi sniper
/positions               → Lihat posisi terbuka
/candidate <mint>        → Detail candidate tertentu
/filters                 → Lihat filter aktif
/pnl                     → Lihat PnL historis
/learn <window>          → Jalankan learning dari dry-run evidence
/lessons                 → Lihat learning lessons aktif
/walletadd mywallet <addr>  → Tambah wallet yang dipantau
/walletremove mywallet   → Hapus wallet dari pantauan
/wallets                 → Lihat daftar wallet tersimpan
```

---

## 7. Contoh Penggunaan

### Contoh 1: Setup Dry Run (Testing)

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234...
TELEGRAM_CHAT_ID=-1001234567890
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=your_key_here
SIGNAL_POLL_MS=30000
TRADING_MODE=dry_run
ENABLE_LLM=true
LLM_BASE_URL=https://api.minimax.io/v1
LLM_API_KEY=your_llm_key
LLM_MODEL=MiniMax-M2.7
GMGN_ENABLED=true
GMGN_API_KEY=your_gmgn_key
GMGN_REQUEST_DELAY_MS=2500
```

```bash
npm install
npm start
```

Charon akan:
1. Connect ke Telegram dan mulai polling signal server
2. Setiap candidate baru di-enrich (GMGN, Jupiter, wallet, Twitter)
3. Filter dijalankan sesuai strategi aktif
4. LLM screening batch setiap ada kandidat baru
5. Hasil buy disimpan sebagai **dry run position** (simulasi)
6. Cek perintah `/positions`, `/pnl`, `/learn 7d`

### Contoh 2: Ubah Strategi ke Smart Money

```
/strategy smart_money
/stratset smart_money tp_percent 100
/stratset smart_money sl_percent -15
/stratset smart_money trailing_percent 15
```

Perubahan langsung aktif tanpa restart (hot-read dari SQLite).

### Contoh 3: Monitoring Wallet Tertentu

```
/walletadd whale1 DfXygSm...abc
/walletadd whale2 7xKXtg2C...def
/wallets
```

Charon akan menyuntikkan data `savedWalletExposure` ke setiap candidate — apakah ada holder dari wallet yang kamu pantau?

### Contoh 4: Learning from Dry-Run Evidence

```
/learn 7d
```

Charon menganalisis semua dry-run 7 hari terakhir:
- Rute mana yang paling profitable?
- Rute mana yang paling sering SL?
- LLM menghasilkan "lessons" dari bukti historis ini
- Lessons disuntikkan ke prompt LLM untuk screening berikutnya

```
/lessons    → lihat lessons aktif
```

### Contoh 5: Mode Confirm (Man-in-the-Middle)

```env
TRADING_MODE=confirm
SOLANA_PRIVATE_KEY=<wallet key>
JUPITER_API_KEY=<jupiter key>
```

Charon akan:
1. Melakukan screening seperti biasa
2. Saat LLM memutuskan BUY, kirim pesan ke Telegram dengan tombol **Approve** / **Reject**
3. User klik → eksekusi Jupiter swap sesungguhnya
4. User reject → posisi tidak jadi dibuka

### Contoh 6: Disable LLM (Pure Rule-Based)

```
/strategy degen
```

atau via `.env`:
```env
ENABLE_LLM=false
```

Degen strategy secara default `use_llm: false` — semua kandidat yang lolos filter auto-approve.

---

## 8. Best Practices

### Setup Awal
1. **Selalu mulai dengan `dry_run`** minimal 1-2 minggu sebelum live. Pahami bagaimana LLM dan filter bekerja dengan kondisi pasar saat ini.
2. **Siapkan Helius RPC berbayar** sebelum beralih ke `confirm` atau `live`. Free tier akan throttle di bawah beban position monitoring.
3. **Backup `charon.sqlite` secara berkala**. Ini satu-satunya sumber kebenaran — semua keputusan, posisi, lessons, dan strategi ada di sini.

### Tuning Strategi
4. **Gunakan `/stratset`** untuk tuning parameter, bukan edit `.env`. Settings SQLite bisa diubah secara real-time.
5. **Perhatikan `max_open_positions`**. Default 3 cukup untuk sebagian besar akun. Lebih tinggi = lebih banyak exposure ke risiko rug.
6. **`llm_min_confidence` default 50 terlalu rendah** untuk live trading. Naikkan ke 70-80 untuk mengurangi false positive.

### LLM
7. **MiniMax M2.7** adalah pilihan paling cost-efficient untuk use case ini. OpenAI GPT-4o juga bisa, tapi lebih mahal.
8. **LLM timeout 120 detik** sudah cukup. Jangan turunkan — prompt bisa panjang karena ada 10 candidate + lessons.
9. **LLM candidate pick count 10** berarti setiap batch mengevaluasi 10 kandidat terbaru dalam satu API call. Lebih tinggi = lebih lengkap konteks, tapi lebih mahal per call.

### GMGN & Rate Limits
10. **Jangan turunkan `GMGN_REQUEST_DELAY_MS` di bawah 2500ms**. Menjalankan banyak instance atau menurunkan delay akan menyebabkan key banned.
11. GMGN enrichment bisa di-disable (`GMGN_ENABLED=false`) jika tidak ada key — Charon fallback ke Jupiter dan data signal server.

### Position Management
12. **Trailing TP diaktifkan default**. Ini penting untuk memaksimalkan gains di pasar volatile.
13. **Partial TP berguna di smart_money** — ambil profit sebagian, biarkan sisa berjalan.
14. **Position monitor mengirim alert setelah 3x gagal polling**. Jika RPC unreliable, perpanjang `POSITION_CHECK_MS` atau upgrade plan.

### Learning
15. **Jalankan `/learn 7d` secara berkala**. Lessons yang dihasilkan langsung mempengaruhi screening LLM berikutnya.
16. **Lihat `/lessons`** untuk memahami pola yang dipelajari. Jika lessons tidak masuk akal, mungkin dry-run evidence belum cukup.

### Keamanan
17. **Jangan commit `.env` ke git**. Private key, API keys, semuanya sensitif.
18. **LIVE_MIN_SOL_RESERVE jangan dihilangkan**. Ini guardrail terakhir agar wallet tidak terkuras habis.
19. **Fresh execution guard** — sebelum live swap, Charon melakukan refresh data kandidat. Jika filter gagal pada data segar (misal mcap tiba-tiba drop), eksekusi dibatalkan.

### Deployment
20. **Gunakan PM2 atau systemd** untuk menjalankan Charon sebagai service:
```bash
pm2 start index.js --name charon
pm2 save
pm2 logs charon
```
21. **Verifikasi sebelum production**:
```bash
npm run check    # syntax check semua file utama
```

---

## 9. Debugging & Troubleshooting

| Masalah | Kemungkinan Penyebab | Solusi |
|---------|---------------------|--------|
| Tidak ada candidate muncul | Signal server key expired / URL salah | Cek `SIGNAL_SERVER_KEY`, kontak maintainer |
| Semua candidate filtered | Strategi terlalu ketat / filter tidak realistis | `/filters` untuk review, `/stratset` untuk relax |
| LLM gagal / timeout | API key salah / endpoint down / timeout terlalu pendek | Cek `LLM_API_KEY`, `LLM_BASE_URL`, naikkan `LLM_TIMEOUT_MS` |
| GMGN error 429 | Rate limit exceeded | Naikkan `GMGN_REQUEST_DELAY_MS`, kurangi polling |
| Live execute gagal | Insufficient SOL / RPC error / Jupiter down | Cek `LIVE_MIN_SOL_RESERVE`, saldo wallet, RPC status |
| Position tidak update | Position monitor error 3x berturut-turut | Cek RPC reliability, Helius status |
| SQLite corrupt | Crash saat write | Backup restore, hapus `-wal` `-shm` |

---

## 10. Database Schema (Ringkasan)

Tabel utama di `charon.sqlite`:

| Tabel | Isi |
|-------|-----|
| `candidates` | Semua kandidat token + sinyal + enrichment + status |
| `decisions` | Keputusan LLM per kandidat (verdict, confidence, reason) |
| `batch_decisions` | Batch LLM decisions (trigger + rows + picked candidate) |
| `decision_events` | Log event (entry_skipped, dry_run_entry, live_entry, dll) |
| `dry_run_positions` | Posisi (open/closed) dengan TP, SL, trailing, PnL |
| `dry_run_trades` | Riwayat trade (entry + exit) per posisi |
| `trade_intents` | Intent perdagangan (mode confirm) dengan status |
| `saved_wallets` | Daftar wallet yang dipantau |
| `strategies` | Konfigurasi strategi (JSON) |
| `settings` | Settings global (key-value) |
| `learning_runs` | Riwayat learning runs |
| `learning_lessons` | Lessons aktif dari learning |
| `price_alerts` | Alert harga untuk dip buy |

---

*Handbook ini berdasarkan codebase Charon v1.0.0. Untuk update terbaru, cek README.md dan source code di repo.*
