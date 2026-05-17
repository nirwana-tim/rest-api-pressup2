# Press Up — Background Audio Processor (API 2)

API kedua ini bertindak sebagai **Background Worker** untuk memproses file audio yang besar tanpa memblokir aplikasi utama (`rest-api-pressup 1`).

Tugas utamanya adalah:
1. Menerima request webhook dari API 1.
2. Mengirim file audio ke **AssemblyAI** untuk ditranskripsi menjadi teks.
3. Mengirim hasil teks ke **Groq AI** (menggunakan model Llama-3.3) untuk mendeteksi *filler words*, kelancaran bicara, dan memberikan rekomendasi kosa kata.
4. Menyimpan hasil *feedback* secara langsung ke database **Supabase**.

## 🚀 Memulai (Setup Lokal)

### 1. Instalasi

```bash
cd rest-api-pressup2
npm install
```

### 2. Konfigurasi Environment

Buat file `.env` di root project `rest-api-pressup2` dan sesuaikan dengan kredensial dari API 1 dan AssemblyAI:

```env
PORT=3001
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
ASSEMBLYAI_API_KEYS=<your-assemblyai-key1>,<your-assemblyai-key2>
GROQ_API_KEY=<your-groq-api-key>
API_SECRET_KEY=pressup_secret_secure_key_2026
```

> [!IMPORTANT]
> - `ASSEMBLYAI_API_KEYS` mendukung beberapa kunci yang dipisahkan koma untuk fitur rotasi API key secara otomatis ketika mencapai *rate limit*.
> - `API_SECRET_KEY` adalah kunci rahasia bersama (Shared Secret) untuk memvalidasi request dari API 1 demi keamanan.

### 3. Jalankan Aplikasi

```bash
npm start
```

Server secara default akan berjalan di `http://localhost:3001`.

## 📡 Endpoint

### `POST /api/process-audio`

Endpoint internal yang dipanggil oleh `rest-api-pressup 1`. Memerlukan otentikasi header keamanan.

- **Headers**: 
  - `Content-Type: application/json`
  - `x-api-secret: <API_SECRET_KEY>`

- **Payload Body:**
```json
{
  "sessionId": "<id-sesi-game>",
  "audio_url": "https://<supabase-storage-url>/file.m4a",
  "duration": 120
}
```

- **Response (Langsung / Non-blocking):**
```json
{
  "message": "Background audio processing started",
  "sessionId": "<id-sesi-game>"
}
```

## 🛠️ Logika Bisnis & Penanganan Otomatis

1. **Keamanan Webhook**: Setiap request wajib menyertakan header `x-api-secret` yang cocok dengan `API_SECRET_KEY` di server. Jika tidak ada atau tidak cocok, respons `401 Unauthorized` akan dikembalikan seketika.
2. **Sinkronisasi Status Sesi (`game_sessions`)**:
   - Saat pemrosesan dimulai di API 1, status sesi diubah menjadi `processing`.
   - Begitu API 2 berhasil memproses transkripsi & feedback AI, status di tabel `game_sessions` akan diperbarui secara otomatis menjadi `'completed'` dan field `total_score` akan diisi berdasarkan skor Groq (`overall_score`).
   - Jika terjadi kesalahan fatal (error), status sesi di `game_sessions` dan `audio_recordings` akan otomatis diubah menjadi `'failed'`.
3. **Penyimpanan Repeated Words**: Statistik kata yang berulang dari analisis Groq akan dihitung secara akurat dan disimpan langsung ke tabel terpisah `feedback_repeated_words`.
4. **Penanganan Audio Hening (Silence)**: Jika hasil transkripsi audio hening/kosong (`""`), sistem akan menghindari error *deadlock* dengan melewati analisis AI dan langsung membuat entri `feedbacks` dengan pesan default (summary: *"Tidak ada suara atau percakapan yang terdeteksi pada rekaman audio."*) dan menandai status sesi sebagai `'completed'`.