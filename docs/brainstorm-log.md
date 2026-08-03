# Brainstorm & decision log

Catatan evolusi ide proyek rocky, Agustus 2026. Disimpan supaya enam bulan dari
sekarang kita ingat *kenapa* keputusan diambil — bukan cuma apa keputusannya.
Format: kronologis, dengan verdict per ide.

## Evolusi konsep

1. **Terminal pet murni** — Rocky sebagai tamagotchi di terminal.
   → Riset menunjukkan space ini ramai (puluhan git-fed tamagotchi, pet untuk
   Claude Code, dsb). Ditolak sebagai konsep utama, dipertahankan sebagai
   *lapisan kepribadian*.

2. **rocky-fix: AI debugging agent** (proposal eksternal) — CLI `run/map/ask`
   dengan LLM untuk vibe coder.
   → Ditolak sebagai jantung proyek: head-to-head dengan Claude Code, aider,
   gh copilot (pemain besar). Fitur context-gathering-nya dipertahankan
   sebagai teknik, bukan produk.

3. **Tiga alternatif se-scope** (proposal eksternal): audit / ship / test.
   - `rocky-audit` (security & cleanup): feasible tapi jadi aggregator tool
     existing (gitleaks, knip). → Diserap jadi fitur "hull check" yang lebih
     sempit: khusus kesalahan khas AI (paket halusinasi, secrets).
   - `rocky-ship` (commit generator): pasar paling jenuh (aicommits dkk,
     built-in di Copilot/Cursor). → Ditolak sebagai produk; boleh jadi fitur
     kecil belakangan.
   - `rocky-test` (chaos engineer): ide paling segar, TAPI klaim "scope sama"
     tidak benar — butuh eksekusi kode tersandbox, 3–4x lebih kompleks, dan
     tanpa trigger moment natural. → Ditunda ke masa depan jauh.
   - Kerangka evaluasi yang dipakai: *trigger moment* (crash > commit >
     deploy > "inget sendiri") — frekuensi & urgensi momen pemakaian
     menentukan hidup-matinya CLI.

4. **Riset persona → tiga ide baru dari trait Rocky:**
   - Memori fotografis Eridian → **`rocky remember`** (error→fix memory).
     → DITERIMA sebagai jantung proyek. Alasan: satu-satunya yang unik di
     pasar (cuma ada atuin/shell history, tanpa error-awareness), berguna
     untuk vibe coder DAN manual coder, makin lama makin berharga, dan
     paling "Rocky" dari semua ide.
   - 46 tahun sendirian → **`rocky watch`** (penunggu proses panjang).
     → Diterima sebagai fitur sekunder.
   - Maksa Grace tidur → **`rocky care`** (guardian jam kerja).
     → Diterima sebagai lapisan kepribadian, nilai brand > nilai produk.
   - Buta + penasaran → **`rocky explain`** (blind rubber duck; user
     menjelaskan kode ke Rocky, dia bertanya balik). → Diterima; landasan:
     self-explanation effect (Chi 1994) + retrieval practice (Roediger &
     Karpicke 2006). Kelemahan yang diakui: tanpa trigger natural, harus
     dipicu otomatis setelah diff besar.

5. **Positioning final:** *comprehension guardian* — "Everyone builds AI that
   codes for you. Rocky makes sure you still understand what got built."
   Komplemen AI coding agent, bukan pesaing.

6. **Koreksi konsep visual (penting):** Rocky BUKAN TUI pet. CLI/package
   hidup di terminal; **pet-nya muncul di luar terminal** sebagai jendela
   desktop transparan (SVG, always-on-top, click-through) yang bereaksi ke
   event terminal. Diferensiator utama vs semua terminal pet yang ada.

## Keputusan teknis tercatat

- **TypeScript saja**, bukan dual Node/Python — beban maintenance.
- **Zero runtime dependency** untuk CLI — instalasi instan, kebal
  supply-chain, konsisten dengan fitur anti-paket-halu.
- **Tanpa LLM di v0.1** — loop memory harus berguna dengan zero setup;
  layer LLM menyusul sebagai opt-in BYOK/Ollama dengan degraded mode wajib
  di tiap fitur.
- **Event bus berbasis file** (`~/.rocky/events.jsonl`) antara CLI dan pet,
  bukan socket — CLI tak pernah gagal karena pet mati, pet bisa replay,
  debuggable dengan tail. Event bus tanpa isi stderr/kode (privasi).
- **Electron dulu untuk pet, Tauri dievaluasi belakangan** — kecepatan
  sampai demo > ukuran binary; logika visual portable via webview.
- **Fingerprinting stderr**: masking bagian volatile (path/angka/timestamp)
  lalu hash — jantung teknis `remember`. Fix-linking heuristik: sukses
  dengan base program sama, cwd sama, ≤48 jam setelah failure.
- **Persona sebagai aturan yang bisa dienforce**: ", question" bukan "?",
  repetisi untuk emphasis, tanpa artikel, tak pernah "melihat". Saat serius,
  informasi ditulis lurus; kepribadian hanya di sekelilingnya. `--quiet`
  direncanakan.
- **IP**: fan project non-komersial, art original (SVG gambar sendiri dari
  deskripsi novel), disclaimer di README, tanpa aset buku/film.

## Rating jujur terakhir (penilaian netral, Agustus 2026)

Overall 7/10. Kekuatan: konsep unik di irisan kosong, fondasi CLI sudah
teruji, nilai portfolio tinggi (9/10). Kelemahan yang diakui: keberlanjutan
solo dev + dua codebase (5/10), friksi adopsi wrapper `rocky run` sebelum
shell hook jadi, nilai memory baru terasa setelah minggu-minggu pemakaian,
dan scope creep adalah risiko #1 — disiplin memotong scope menentukan apakah
ini jadi 8.5 atau 4. Aturan yang disepakati: **v0.2 = pet 3 pose, 1 OS,
titik.**

## Bacaan pendukung

Lihat `scientific-grounding.md` di folder ini — semua sitasi sudah
diverifikasi langsung ke arXiv/ACM (termasuk koreksi: 2404.17153 kini
berjudul *UniDebugger*; klaim Debug2Fix ">20%" hanya untuk model tertentu).

## Sesi lanjutan (3 Agu 2026): stress test nilai + pagar scope

- **Keraguan yang diuji**: "buat apa `remember` kalau ada AI chat / orang inget
  sendiri?" Verdict jujur: buat error umum, keraguan itu BENAR — AI chat cukup
  dan rocky cuma marginal. `remember` menang telak hanya di error
  spesifik-lingkungan yang berulang (fix-nya adalah sejarahmu sendiri, bukan
  pengetahuan umum) dan saat offline. Konsekuensi: `remember` resmi berstatus
  "bonus yang sesekali ajaib", bukan alasan utama install. Identitas produk
  tetap pet + kepribadian + paket fitur yang saling menutup kelemahan.
- **Ide ekspansi yang ditolak**: rocky sebagai pencatat aktivitas umum di luar
  terminal yang bisa bilang "yang kamu lakuin salah". Ditolak karena: wilayah
  Rewind/Recall/screenpipe (butuh screen capture, berat, per-OS), risiko
  kepercayaan/privasi fatal untuk project kecil, dan "AI yang terus menonton
  dan menghakimi" bertentangan dengan karakter Rocky (care, bukan pengawas).
- **Yang lahir dari insting yang sama**: **penjaga command berbahaya** (masuk
  v0.4, satu keluarga dengan hull check). Rocky mencegat sebelum eksekusi:
  `rm -rf` di direktori tak biasa, `git push --force` ke main, command
  destruktif menyentuh prod, `curl | bash` dari domain asing. Pure rules
  lokal (offline), LLM opsional, zero isu privasi (baca command, bukan layar),
  sangat in-character, dan berguna bahkan untuk orang yang tak pernah lupa —
  masalah yang dijawab bukan lupa, tapi khilaf. Juga relevan untuk agent AI
  yang menjalankan command.
- **Pagar scope yang dikunci**: "Rocky mendengar terminal, titik." Semua yang
  butuh mata (layar, aplikasi lain, aktivitas umum) berada di luar project ini
  secara permanen.

## Sesi lanjutan 3 (3 Agu 2026): kombinasi vibe coding — provenance memory

Ide baru: "Rocky remember everything that AI code and explain it, easily."
Dipecah dua, verdict berbeda:

- **"Remember everything AI codes"** → DITERIMA sebagai arah v0.5.
  Provenance memory: Rocky mencatat kode mana lahir dari AI, kapan, sesi apa.
  Deteksi feasible & offline: trailer commit `Co-Authored-By: Claude`
  (Claude Code), marker `(aider)`, git diff journal; hook Claude Code bisa
  lapor langsung. Unik di pasar, makin lama makin berharga, masih dalam pagar
  "mendengar terminal" (git + terminal, tanpa mata).
- **"Explain it easily" (Rocky menjelaskan kode ke user)** → DITOLAK dalam
  bentuk mentahnya. Dua alasan: (1) bertentangan dengan landasan ilmiah
  sendiri — Chi 1994 & Roediger 2006: yang *menjelaskan* itu paham, yang
  *dijelaskan* itu kondisi lemah; (2) head-to-head dengan semua AI tool,
  alasan persis rocky-fix dulu ditolak. Plus butuh LLM (wilayah BYOK).
- **Sintesis yang diterima**: **comprehension debt tracker** — gabungan
  provenance memory (baru) + `rocky explain` (sudah di roadmap). Rocky buta,
  tak bisa baca kode; dia *ingat* apa yang AI bangun dan *menagih* user
  menjelaskannya: "AI write 340 lines yesterday. you explain zero. explain
  this one to me, question." LLM opsional hanya untuk pertanyaan lanjutan.
- **Keputusan scope**: diparkir sebagai v0.5. Spec v0.2–v0.4
  (hook+guard / watch / hull check) tetap terkunci; desain penuh setelah
  v0.2 rilis.
