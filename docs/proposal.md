# rocky — proposal proyek

**Pet desktop yang hidup di luar terminal, dengan otak yang hidup di dalamnya.**

Rocky adalah proyek open source dua bagian: sebuah CLI/package yang bekerja di terminal (mencatat error, mengingat solusi, mengawasi proses), dan sebuah pet desktop — Rocky si Eridian dari *Project Hail Mary*, dirender sebagai SVG di jendela transparan selalu-di-atas — yang bereaksi terhadap apa yang terjadi di terminal secara real time. Build gagal: Rocky di pojok layar berhenti menggantung santai dan panik. Kamu memperbaikinya: dia merayakan. Error lama muncul lagi: dia yang memberi tahu solusinya, karena Eridian tidak pernah lupa.

Terminal pet sudah banyak; semuanya terkurung di dalam terminal dan mati saat tab ditutup. Desktop pet juga sudah ada (tradisi Shimeji); tidak satu pun terhubung ke pekerjaan nyata developer. Rocky berdiri tepat di irisan kosong keduanya: **desktop companion yang digerakkan oleh aktivitas engineering sungguhan.**

---

## 1. Konsep dalam satu skenario

1. Kamu install: `npm i -g rocky-cli`, lalu jalankan `rocky pet`. Jendela kecil transparan muncul di pojok layar: Rocky menggantung dari "langit-langit" habitatnya, sesekali bergoyang. Tidak menghalangi klik (click-through), tidak muncul di taskbar.
2. Di terminal, kamu kerja seperti biasa lewat `rocky run "npm run build"` (atau, setelah shell hook terpasang, tanpa wrapper sama sekali).
3. Build gagal. Di terminal, Rocky mencatat error dan menulis satu baris. Di layar, pet-nya bereaksi: pose siaga, gestur "bad bad".
4. Kamu memperbaiki, build hijau. Pet melompat, terminal mencatat: fix tersimpan, terhubung ke error tadi.
5. Tiga bulan kemudian error yang sama muncul. Terminal: `I remember this error. 84 days ago. Last time, you fix with: ...`. Pet: pose "mengingat", lalu menunjuk ke bawah seolah menyerahkan solusi.
6. Jam satu pagi kamu masih commit. Pet menguap, menggantung terbalik, dan bubble kecil muncul: `you code 4 hours. sleep, question`.

CLI tetap berguna penuh tanpa pet (untuk SSH, server, orang yang tidak mau jendela tambahan). Pet adalah wajah; CLI adalah organ dalam.

## 2. Arsitektur

```
┌──────────────────────────┐         ┌──────────────────────────────┐
│ terminal                 │         │ desktop (jendela overlay)    │
│                          │         │                              │
│  rocky run / recall /    │  tulis  │   rocky pet (webview)        │
│  watch / shell hook      │──────┐  │   ┌───────────────────┐      │
│        │                 │      │  │   │  SVG Rocky        │      │
│        ▼                 │      │  │   │  state machine:   │      │
│  core engine             │      │  │   │  idle/alert/happy │      │
│  · fingerprint.ts        │      │  │   │  /remember/sleep  │      │
│  · memory.jsonl          │      │  │   └───────▲───────────┘      │
│  (~/.rocky/)             │      │  │           │ tail + replay    │
└──────────────────────────┘      │  │           │                  │
                                  ▼  │           │                  │
                        ~/.rocky/events.jsonl ───┘                  │
                        (event bus append-only)                     │
                                     └──────────────────────────────┘
```

Dua proses yang tidak saling bergantung, dihubungkan **event bus berbasis file**: CLI menulis event sebagai baris JSONL ke `~/.rocky/events.jsonl`; aplikasi pet men-tail file itu (fs.watch + offset) dan menerjemahkan event jadi animasi. Kenapa file dan bukan socket/WebSocket:

- CLI tetap zero-dependency dan tidak pernah gagal karena pet mati/belum jalan.
- Pet yang dinyalakan belakangan bisa replay event terakhir (misal menampilkan mood berdasarkan sesi hari ini).
- Debuggable dengan `tail -f`. Sesuai selera proyek ini: jujur dan bisa dibaca manusia.
- Upgrade path ke Unix socket/WebSocket tetap terbuka kalau nanti butuh latensi lebih rendah atau komunikasi dua arah (pet mengirim perintah balik).

### Protokol event (draf v1)

```jsonc
{"ts":1754190000000,"type":"cmd_failed","cmd":"npm run build","fingerprint":"a1b2...","known":true,"hasFix":true}
{"ts":...,"type":"cmd_fixed","cmd":"npm run build","resolvedCount":1}
{"ts":...,"type":"recall_hit","query":"sharp"}
{"ts":...,"type":"session_idle","minutes":30}
{"ts":...,"type":"long_session","hours":4}
{"ts":...,"type":"watch_done","cmd":"docker build .","ok":true,"durationSec":812}
```

Prinsip privasi: event bus tidak pernah memuat isi stderr atau isi kode — hanya tipe kejadian, command, dan metadata. Detail tetap di `memory.jsonl` yang hanya dibaca CLI.

### Komponen pet (jendela desktop)

Kebutuhan teknis: jendela transparan, always-on-top, tanpa frame, tanpa taskbar, click-through (klik tembus ke aplikasi di belakangnya), bisa di-drag saat mode "pegang". Dua kandidat runtime:

| | Electron | Tauri v2 |
|---|---|---|
| Bahasa | 100% TypeScript | Rust shell + frontend TS |
| Transparan + always-on-top + click-through | `transparent`, `setAlwaysOnTop`, `setIgnoreMouseEvents` — matang | didukung (`transparent`, ignore cursor events) |
| Ukuran distribusi | ~80–100 MB | ~5–10 MB |
| Kecepatan development untukmu | tercepat (stack yang sudah kamu pakai) | perlu belajar toolchain Rust |

**Rekomendasi: Electron untuk v1, evaluasi Tauri di v2.** Alasan: kecepatan sampai ke demo lebih penting daripada ukuran binary untuk proyek yang nilainya ada di kepribadian dan loop memory-nya; migrasi mudah karena seluruh logika visual ada di webview (SVG + TS) yang portable ke Tauri tanpa perubahan.

### Rocky sebagai SVG

SVG dipilih tepat karena karakternya: bentuk Rocky adalah geometri (carapace pentagonal, lima kaki radial, tiga jari per tangan, tanpa wajah) — cocok digambar sebagai vektor, dianimasikan lewat CSS transform + Web Animations API per grup anatomi (`<g id="leg-1">` dst.). Ini juga keputusan hukum yang aman: kita menggambar interpretasi original dari deskripsi novel, bukan memakai aset film.

State machine visual (v1, cukup 6 state):

| State | Pemicu (event) | Animasi |
|---|---|---|
| `idle` | default | menggantung, goyangan pelan, sesekali "mendengarkan" (kaki bergerak) |
| `alert` | `cmd_failed` (known=false) | turun dari gantungan, pose siaga, getar kecil |
| `remember` | `cmd_failed` (known=true) | pose "menunjuk", pulse pada carapace |
| `happy` | `cmd_fixed` | lompatan pendek, "fist my bump" ke arah kursor |
| `waiting` | `watch_*` berjalan | duduk diam, sangat diam (46 tahun diam) |
| `sleepy` | `long_session` | menggantung terbalik, gerakan melambat, bubble ajakan tidur |

Karena Rocky tidak punya wajah, seluruh emosi harus lewat **postur dan tempo** — ini justru tantangan desain yang membuat proyek ini menarik untuk dikerjakan dan di-showcase.

## 3. Fitur dan pembagian peran

| Fitur | Tempat hidup | Status |
|---|---|---|
| `rocky run` — jalankan command, ingat error→fix | CLI | **sudah dibangun & teruji (v0.1)** |
| `rocky recall` — cari memori error | CLI | **sudah dibangun & teruji (v0.1)** |
| `rocky stats` | CLI | **sudah dibangun & teruji (v0.1)** |
| `rocky pet` — jendela desktop SVG | Desktop | v0.2 (MVP berikutnya) |
| Event bus `events.jsonl` | CLI → Desktop | v0.2 |
| `rocky watch` — penunggu proses panjang | CLI + reaksi pet | v0.3 |
| Shell hook zsh/fish (tanpa wrapper `run`) | CLI | v0.3 |
| Hull check pre-push (paket halu, secrets, 1 pertanyaan komprehensi) | CLI + reaksi pet | v0.4 |
| Penjaga command berbahaya — cegat `rm -rf` di tempat aneh, force-push ke main, command destruktif beraroma prod, `curl \| bash` asing; rules lokal (offline), LLM opsional | CLI + reaksi pet | v0.4 |
| `rocky explain` — blind rubber duck | CLI (LLM opsional) | v0.5 |
| Layer LLM opt-in (Ollama / BYOK) | CLI | v0.5 |

Catatan: engine memory v0.1 (fingerprinting stderr, JSONL store, fix-linking heuristik 48 jam, fuzzy recall) sudah ada, ter-compile, dan lolos smoke test end-to-end — zero runtime dependency. Kode itu menjadi fondasi; penambahan di v0.2 adalah *emitter* event (beberapa baris di titik-titik yang sudah ada) plus aplikasi pet yang sepenuhnya terpisah.

## 4. MVP v0.2 — definisi selesai

1. `rocky pet` membuka jendela Electron transparan, always-on-top, click-through, posisi tersimpan.
2. SVG Rocky dengan minimal state `idle`, `alert`, `happy`.
3. CLI menulis `cmd_failed` / `cmd_fixed` ke event bus; pet bereaksi < 500 ms.
4. Pet mati ≠ CLI terganggu; CLI mati ≠ pet crash (dia kembali `idle`).
5. Satu GIF demo di README: terminal kiri, Rocky kanan, error → panik → fix → lompat. GIF ini adalah aset marketing utama proyek.

## 5. Risiko yang diakui sejak awal

- **Dua codebase untuk satu solo developer.** Mitigasi: pet dibuat sebisa mungkin "bodoh" (murni penerjemah event→animasi, tanpa logika bisnis); semua kecerdasan tetap di CLI yang sudah jadi.
- **Overlay lintas OS itu penuh jebakan** (multi-monitor, DPI scaling, perilaku click-through beda di Windows/macOS/Linux-Wayland). Mitigasi: v0.2 menarget satu OS utama dulu (yang kamu pakai harian), OS lain menyusul lewat kontributor.
- **Pet bisa terasa mengganggu.** Mitigasi: semua reaksi bersifat singkat lalu kembali idle; ada `rocky pet --calm` (tanpa bubble, hanya postur) dan pengaturan jam tenang.
- **IP fan project.** Karakter milik Andy Weir/penerbit/studio: proyek non-komersial, disclaimer jelas, seluruh art original buatan sendiri, tanpa aset buku/film.

## 6. Landasan ilmiah

Argumen riset lengkap (comprehension gap pada vibe coding, "pajak re-finding" developer, efek self-explanation dan retrieval practice untuk fitur explain, serta batas-batas automated debugging) ada di dokumen terpisah: `docs/scientific-grounding.md` — sudah diverifikasi langsung ke sumber arXiv/ACM-nya.

---

*rocky adalah fan project tidak resmi yang terinspirasi dari karakter Rocky dalam novel* Project Hail Mary *karya Andy Weir. Tidak berafiliasi dengan Andy Weir, Ballantine Books, atau Amazon MGM Studios. Tidak ada aset dari buku maupun film yang digunakan.*
