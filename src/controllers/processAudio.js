import { AssemblyAI } from 'assemblyai';
import Groq from 'groq-sdk';
import { supabaseAdmin } from '../config/supabase.js';

// Initialize Groq
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// AssemblyAI ApiKeyRotator reference logic
class ApiKeyRotator {
  constructor() {
    this.keys = process.env.ASSEMBLYAI_API_KEYS?.split(',').map(k => k.trim()) || [];
    this.currentIndex = 0;
  }

  getNextClient() {
    if (this.keys.length === 0) {
      throw new Error('No API keys found in .env (ASSEMBLYAI_API_KEYS)');
    }
    const key = this.keys[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    return new AssemblyAI({ apiKey: key });
  }

  getKeyCount() {
    return this.keys.length;
  }
}

const rotator = new ApiKeyRotator();

const DEFAULT_MR_OWI_TIPS = {
  artikulasi: [
    'Hindari menelan akhir kata atau berbicara terlalu cepat sehingga pengucapan terdengar samar.',
    'Gerakan mulut yang jelas membantu suara terdengar lebih tegas dan mudah dipahami.',
    'Ulangi kata atau istilah penting beberapa kali agar lidah terbiasa dan tidak terbata-bata saat menyampaikannya.'
  ],
  intonasi: [
    'Beri penekanan pada kata atau poin penting agar pesan lebih jelas dan tidak terdengar datar.',
    'Variasikan nada saat menjelaskan bagian penting atau saat berpindah topik agar penyampaian lebih hidup. Hindari nada monoton.',
    'Jangan berbicara dengan satu nada terus-menerus, karena dapat membuat audiens cepat bosan atau kehilangan fokus.'
  ],
  kata_jeda: [
    'Saat butuh waktu berpikir, lebih baik berhenti sejenak daripada mengisi dengan kata pengisi. Diam singkat terlihat lebih percaya diri.',
    'Siapkan penghubung seperti "selanjutnya", "berikutnya", atau "jadi" agar alur bicara lebih terstruktur dan tidak terputus-putus.',
    'Dengarkan kembali rekaman presentasi untuk menyadari seberapa sering filler muncul, lalu perbaiki secara bertahap.'
  ],
  pemborosan_kata: [
    'Hindari penggunaan ganda seperti "sangat sekali", "benar-benar sangat", atau "agar supaya". Pilih salah satu yang paling kuat.',
    'Hindari pengulangan makna dalam satu kalimat. Jika pesan sudah jelas, tidak perlu ditambah kata yang hanya memperpanjang tanpa menambah arti.'
  ]
};

function normalizeTipList(value, fallback) {
  if (!Array.isArray(value)) return fallback;

  const cleaned = value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);

  return cleaned.length > 0 ? cleaned : fallback;
}

function normalizeMrOwiTips(tips = {}) {
  return {
    artikulasi: normalizeTipList(tips.artikulasi, DEFAULT_MR_OWI_TIPS.artikulasi),
    intonasi: normalizeTipList(tips.intonasi, DEFAULT_MR_OWI_TIPS.intonasi),
    kata_jeda: normalizeTipList(tips.kata_jeda, DEFAULT_MR_OWI_TIPS.kata_jeda),
    pemborosan_kata: normalizeTipList(tips.pemborosan_kata, DEFAULT_MR_OWI_TIPS.pemborosan_kata)
  };
}

function statusFromScore(score) {
  if (score >= 80) return 'good';
  if (score >= 60) return 'warning';
  return 'bad';
}

function formatDuration(seconds = 0) {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const secs = String(safeSeconds % 60).padStart(2, '0');
  return `${minutes}:${secs}`;
}

function buildTranscriptTokens(transcriptText, fillerWords = [], repeatedWords = []) {
  const fillerSet = new Set(fillerWords.map(word => String(word).toLowerCase()));
  const repeatedSet = new Set(repeatedWords.map(word => String(word).toLowerCase()));

  return transcriptText
    .split(/\s+/)
    .filter(Boolean)
    .map(text => {
      const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      const tags = [];
      if (fillerSet.has(normalized)) tags.push('filler');
      if (repeatedSet.has(normalized)) tags.push('waste');
      return { text, tags };
    });
}

function countWords(items = []) {
  return items.reduce((acc, word) => {
    const key = String(word).toLowerCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildPresentationEvaluation({
  sessionId,
  transcriptText,
  duration,
  analysis,
  telemetry,
  mrOwiTips
}) {
  const fillerWords = analysis.filler_words || [];
  const repeatedWords = analysis.repeated_words || [];
  const fillerCount = analysis.filler_count || fillerWords.length;
  const totalWords = analysis.total_words || transcriptText.split(/\s+/).filter(Boolean).length;
  const durationSeconds = Math.max(Number(duration) || 1, 1);
  const averageWpm = Math.round((totalWords / durationSeconds) * 60);
  const fillerScore = Math.max(0, 100 - fillerCount * 5);
  const wordWasteScore = Math.max(0, 100 - repeatedWords.length * 6);
  const eyeContact = telemetry?.eyeContact;
  const eyeScore = eyeContact?.focusScore ?? 0;
  const fillerCountMap = countWords(fillerWords);
  const fillerSummary = Object.entries(fillerCountMap).map(([word, count]) => ({ word, count }));
  const topFillers = fillerSummary.slice(0, 2).map(item => `"${item.word}"`).join(' dan ');
  const transcript = buildTranscriptTokens(transcriptText, fillerWords, repeatedWords);
  const tempoLabel = averageWpm < 100 ? 'slow' : averageWpm > 160 ? 'fast' : 'normal';

  return {
    sessionId,
    overallScore: analysis.overall_score || 0,
    transcriptText,
    createdAt: new Date().toISOString(),
    summary: [
      {
        id: 'intonation',
        title: 'Intonasi',
        score: analysis.overall_score || 0,
        status: statusFromScore(analysis.overall_score || 0),
        evaluationNote: 'Intonasi dievaluasi dari kelancaran audio dan variasi penyampaian selama presentasi.'
      },
      {
        id: 'eyeContact',
        title: 'Kontak Mata',
        score: eyeScore,
        status: eyeContact ? statusFromScore(eyeScore) : 'unavailable',
        evaluationNote: eyeContact
          ? `Kontak mata terjaga selama ${formatDuration(eyeContact.focusDuration)}, dengan ${formatDuration(eyeContact.unfocusDuration)} momen tidak fokus.`
          : 'Data kontak mata belum tersedia karena tracking wajah tidak aktif selama sesi.'
      },
      {
        id: 'tempo',
        title: 'Tempo',
        score: statusFromScore(averageWpm >= 100 && averageWpm <= 160 ? 90 : 65) === 'good' ? 90 : 65,
        status: averageWpm >= 100 && averageWpm <= 160 ? 'good' : 'warning',
        evaluationNote: `Tempo bicara berada di ${averageWpm} kata per menit dan tergolong ${tempoLabel === 'normal' ? 'stabil' : tempoLabel === 'fast' ? 'cepat' : 'lambat'}.`
      },
      {
        id: 'fillerWords',
        title: 'Kata Jeda',
        score: fillerScore,
        status: statusFromScore(fillerScore),
        evaluationNote: fillerCount > 0
          ? `Terdapat filler word seperti ${topFillers || 'kata jeda'} sebanyak ${fillerCount} kali saat presentasi.`
          : 'Tidak ditemukan kata jeda yang mengganggu selama presentasi.'
      },
      {
        id: 'articulation',
        title: 'Artikulasi',
        score: analysis.overall_score || 0,
        status: 'warning',
        evaluationNote: 'Artikulasi masih dinilai dari kualitas transcript karena confidence per kata belum tersedia.'
      },
      {
        id: 'wordWaste',
        title: 'Pemborosan Kata',
        score: wordWasteScore,
        status: statusFromScore(wordWasteScore),
        evaluationNote: repeatedWords.length > 0
          ? `Terdapat ${repeatedWords.length} kata berulang yang berpotensi membuat penyampaian kurang ringkas.`
          : 'Tidak ditemukan pemborosan kata yang menonjol pada transcript.'
      }
    ],
    details: {
      intonation: {
        chart: [],
        metrics: {},
        aiTips: mrOwiTips.intonasi
      },
      eyeContact: {
        events: eyeContact?.events || [],
        focusDuration: eyeContact?.focusDuration || 0,
        unfocusDuration: eyeContact?.unfocusDuration || 0,
        aiTips: [
          'Arahkan wajah ke kamera saat menyampaikan poin utama.',
          'Gunakan catatan singkat agar tidak terlalu sering melihat ke luar kamera.'
        ]
      },
      tempo: {
        chart: [
          { second: Math.round(durationSeconds * 0.33), wpm: averageWpm },
          { second: Math.round(durationSeconds * 0.66), wpm: averageWpm },
          { second: durationSeconds, wpm: averageWpm }
        ],
        averageWpm,
        segments: [
          {
            startSecond: 0,
            endSecond: durationSeconds,
            label: tempoLabel,
            wpm: averageWpm
          }
        ],
        aiTips: [
          'Jaga tempo di kisaran 100 sampai 160 kata per menit.',
          'Tambahkan jeda singkat setelah menyampaikan poin penting.'
        ]
      },
      fillerWords: {
        transcript,
        fillerWords: fillerSummary,
        totalCount: fillerCount,
        aiTips: mrOwiTips.kata_jeda
      },
      articulation: {
        unclearSegments: [],
        aiTips: mrOwiTips.artikulasi
      },
      wordWaste: {
        transcript,
        wastedPhrases: repeatedWords.map(word => ({
          text: word,
          reason: 'Kata ini terdeteksi berulang dan berpotensi membuat kalimat kurang efisien.'
        })),
        aiTips: mrOwiTips.pemborosan_kata
      }
    }
  };
}

async function upsertFeedback(feedbackData) {
  const { data, error } = await supabaseAdmin
    .from('feedbacks')
    .upsert(feedbackData, { onConflict: 'session_id' })
    .select()
    .single();

  if (!error) return { data, error };

  if (
    feedbackData.evaluation_json &&
    (error.message?.includes('evaluation_json') || error.message?.includes('column'))
  ) {
    const { evaluation_json, ...fallbackData } = feedbackData;
    console.warn('[Supabase] evaluation_json column is unavailable, retrying feedback save without it.');
    return supabaseAdmin
      .from('feedbacks')
      .upsert(fallbackData, { onConflict: 'session_id' })
      .select()
      .single();
  }

  return { data, error };
}

export const processAudio = async (req, res) => {
  const secretKey = req.headers['x-api-secret'];
  
  if (!secretKey || secretKey !== process.env.API_SECRET_KEY) {
    console.warn(`[processAudio] Unauthorized webhook attempt: secret key mismatch.`);
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API secret key' });
  }

  const { sessionId, audio_url, duration, telemetry } = req.body;

  if (!sessionId || !audio_url) {
    return res.status(400).json({ error: 'sessionId and audio_url are required' });
  }

  // Respond immediately that we have started background processing
  res.status(202).json({ message: 'Background audio processing started', sessionId });

  console.log(`[processAudio] Started processing for session: ${sessionId}`);

  let transcriptText = '';
  let transcribed = false;

  // ============================================================
  // TAHAP 1: SPEECH-TO-TEXT DENGAN ASSEMBLYAI & SIMPAN TRANSKRIP
  // ============================================================
  try {
    const keyCount = rotator.getKeyCount();

    for (let attempt = 0; attempt < keyCount; attempt++) {
      const client = rotator.getNextClient();
      try {
        console.log(`[AssemblyAI] Attempting transcription with Key #${attempt + 1}`);
        const transcript = await client.transcripts.transcribe({
          audio: audio_url,
          speech_models: ['universal-3-pro', 'universal-2'],
          language_detection: true,
          speaker_labels: true,
          punctuate: true,
          format_text: true,
        });

        // Parse speaker text
        if (transcript.utterances?.length > 0) {
          transcript.utterances.forEach(u => {
            if (u.speaker === 'A' || u.speaker === 0 || u.speaker === '1') {
              transcriptText += u.text + '\n';
            }
          });
        } else {
          transcriptText = transcript.text || '';
        }

        transcribed = true;
        console.log(`[AssemblyAI] Transcription successful.`);
        break; // Stop attempting if successful
      } catch (error) {
        console.error(`[AssemblyAI] Error with Key #${attempt + 1}:`, error.message);
        const isRateLimit = error.message.includes('429') ||
                            error.message.toLowerCase().includes('rate limit') ||
                            error.message.toLowerCase().includes('concurrency');
        
        if (isRateLimit && attempt < keyCount - 1) {
          console.log('[AssemblyAI] Rate limit detected, rotating to next API key...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else if (!isRateLimit) {
            throw error; // Fail fast if it's not a rate limit issue
        }
      }
    }

    if (!transcribed) {
      throw new Error('All AssemblyAI API keys failed to process the audio');
    }

    transcriptText = transcriptText.trim();

    // ============================================
    // STEP 2: SAVE RAW TRANSCRIPT TO SUPABASE IMMEDIATELY
    // ============================================
    const { error: updateError } = await supabaseAdmin
      .from('audio_recordings')
      .update({
        transcript: transcriptText,
        is_processed: true,
        processing_status: 'completed',
        processed_at: new Date(),
      })
      .eq('session_id', sessionId);

    if (updateError) {
      console.warn('[Supabase] Failed to update audio_recordings:', updateError.message);
      throw updateError;
    }

    console.log(`[Supabase] Raw transcript saved successfully for session ${sessionId}`);

  } catch (error) {
    console.error(`[processAudio] Fatal speech-to-text error for session ${sessionId}:`, error);
    
    // Mark as failed in audio_recordings
    await supabaseAdmin
      .from('audio_recordings')
      .update({ processing_status: 'failed' })
      .eq('session_id', sessionId);

    // Mark as failed in game_sessions
    await supabaseAdmin
      .from('game_sessions')
      .update({ status: 'failed' })
      .eq('id', sessionId);

    return; // Keluar lebih awal karena transkripsi gagal
  }

  // ============================================================
  // TAHAP 2: FEEDBACK ANALYSIS DENGAN GROQ AI
  // ============================================================
  try {
    let finalScore = 0;

    // ============================================
    // STEP 3: ANALYZE WITH GROQ AI OR HANDLE SILENCE
    // ============================================
    if (transcriptText.length > 0) {
      console.log(`[Groq] Starting analysis...`);
      
      const groqPrompt = `
      Anda adalah seorang ahli komunikasi dan pelatih public speaking. Analisis transkripsi berikut.
      Tugas Anda:
      1. Hitung dan deteksi "filler words" (contoh: "eh", "em", "emm", "hmm", "anu").
      2. Analisis tingkat kelancaran berbicara (apakah ada ketidaklancaran/gagap).
      3. Berikan rekomendasi/referensi kata alternatif yang lebih baik untuk menggantikan kata-kata yang kurang tepat.
      4. Berikan total jumlah kata dan skor keseluruhan (0-100).
      5. Wajib keluarkan 4 output teks tips "Tips dari Mr Owi":
         - artikulasi: tips agar pengucapan lebih jelas seperti contoh kartu artikulasi.
         - intonasi: tips agar nada suara tidak monoton seperti contoh kartu intonasi.
         - kata_jeda: tips untuk mengurangi filler words/kata jeda.
         - pemborosan_kata: tips untuk mengurangi kata berlebihan atau pengulangan makna.
      Setiap kategori tips berisi 2-3 kalimat singkat dalam Bahasa Indonesia.
      
      Output harus dalam format JSON yang valid dengan struktur berikut:
      {
        "filler_words": ["eh", "hmm"],
        "filler_count": 2,
        "repeated_words": ["dan"],
        "total_words": 100,
        "overall_score": 85,
        "summary": "Ringkasan evaluasi...",
        "improvement_tips": "Saran perbaikan...",
        "mr_owi_tips": {
          "artikulasi": [
            "Hindari menelan akhir kata atau berbicara terlalu cepat sehingga pengucapan terdengar samar.",
            "Gerakan mulut yang jelas membantu suara terdengar lebih tegas dan mudah dipahami.",
            "Ulangi kata atau istilah penting beberapa kali agar lidah terbiasa dan tidak terbata-bata saat menyampaikannya."
          ],
          "intonasi": [
            "Beri penekanan pada kata atau poin penting agar pesan lebih jelas dan tidak terdengar datar.",
            "Variasikan nada saat menjelaskan bagian penting atau saat berpindah topik agar penyampaian lebih hidup. Hindari nada monoton.",
            "Jangan berbicara dengan satu nada terus-menerus, karena dapat membuat audiens cepat bosan atau kehilangan fokus."
          ],
          "kata_jeda": [
            "Saat butuh waktu berpikir, lebih baik berhenti sejenak daripada mengisi dengan kata pengisi.",
            "Siapkan penghubung seperti selanjutnya, berikutnya, atau jadi agar alur bicara lebih terstruktur.",
            "Dengarkan kembali rekaman presentasi untuk menyadari seberapa sering filler muncul."
          ],
          "pemborosan_kata": [
            "Hindari penggunaan ganda seperti sangat sekali, benar-benar sangat, atau agar supaya.",
            "Hindari pengulangan makna dalam satu kalimat jika pesan sudah jelas."
          ]
        },
        "vocabulary_references": [
          {"original": "kayak", "suggestion": "seperti"},
          {"original": "anu", "suggestion": "(hapus kata ini atau ganti dengan jeda diam)"}
        ]
      }
      Jangan kembalikan apapun selain JSON.
      `;

      const aiResponse = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
            { role: "system", content: groqPrompt },
            { role: "user", content: transcriptText }
        ],
        temperature: 0,
        response_format: { type: "json_object" }
      });

      const analysisText = aiResponse.choices[0].message.content;
      let analysis = {};
      try {
        analysis = JSON.parse(analysisText);
      } catch (e) {
        console.error('[Groq] Failed to parse AI response:', analysisText);
        analysis = { summary: 'Gagal memproses hasil analisis AI.' };
      }

      finalScore = analysis.overall_score || 0;
      const mrOwiTips = normalizeMrOwiTips(analysis.mr_owi_tips);
      const structuredImprovementTips = {
        general: analysis.improvement_tips || 'Terus berlatih.',
        mr_owi_tips: mrOwiTips
      };
      const evaluation = buildPresentationEvaluation({
        sessionId,
        transcriptText,
        duration,
        analysis,
        telemetry,
        mrOwiTips
      });

      // ============================================
      // STEP 4: SAVE FEEDBACK TO SUPABASE
      // ============================================
      const feedbackData = {
        session_id: sessionId,
        filler_score: Math.max(0, 100 - (analysis.filler_count || 0) * 5),
        overall_score: finalScore,
        summary: analysis.summary || 'Tidak ada ringkasan',
        improvement_tips: JSON.stringify(structuredImprovementTips),
        total_words: analysis.total_words || transcriptText.split(' ').length,
        evaluation_json: evaluation,
      };

      // Upsert feedback
      const { data: feedback, error: feedbackError } = await upsertFeedback(feedbackData);

      if (feedbackError) {
        console.warn('[Supabase] Failed to save feedback:', feedbackError.message);
      } else {
        console.log(`[Supabase] Feedback saved successfully for session ${sessionId}`);
        
        // Simpan repeated words ke tabel database feedback_repeated_words
        if (analysis.repeated_words && Array.isArray(analysis.repeated_words) && analysis.repeated_words.length > 0 && feedback) {
          const cleanTranscript = transcriptText.toLowerCase().replace(/[.,!?;:"""''()[\]{}]/g, '');
          const wordsList = cleanTranscript.split(/\s+/);
          
          const repeatedWordsData = analysis.repeated_words.map(word => {
            const occurrences = wordsList.filter(w => w === word.toLowerCase()).length;
            return {
              feedback_id: feedback.id,
              word: word,
              count: occurrences || 1
            };
          });

          // Hapus repeated words lama untuk feedback ini agar tidak melanggar constraint/duplicate insert
          await supabaseAdmin
            .from('feedback_repeated_words')
            .delete()
            .eq('feedback_id', feedback.id);

          const { error: wordsError } = await supabaseAdmin
            .from('feedback_repeated_words')
            .insert(repeatedWordsData);

          if (wordsError) {
            console.warn('[Supabase] Failed to save repeated words:', wordsError.message);
          } else {
            console.log('[Supabase] Repeated words saved successfully');
          }
        }
      }
    } else {
      console.log(`[Groq] Transcript was empty, skipping analysis. Generating default feedback.`);
      finalScore = 0;

      const feedbackData = {
        session_id: sessionId,
        filler_score: 100,
        overall_score: 0,
        summary: 'Tidak ada suara atau percakapan yang terdeteksi pada rekaman audio.',
        improvement_tips: JSON.stringify({
          general: 'Silakan coba berbicara lebih keras atau periksa mikrofon Anda.',
          mr_owi_tips: normalizeMrOwiTips()
        }),
        total_words: 0,
        evaluation_json: buildPresentationEvaluation({
          sessionId,
          transcriptText,
          duration,
          analysis: {
            filler_words: [],
            filler_count: 0,
            repeated_words: [],
            total_words: 0,
            overall_score: 0
          },
          telemetry,
          mrOwiTips: normalizeMrOwiTips()
        })
      };

      const { error: feedbackError } = await upsertFeedback(feedbackData);

      if (feedbackError) {
        console.warn('[Supabase] Failed to save default feedback:', feedbackError.message);
      }
    }

    // ============================================
    // STEP 5: SYNC GAME SESSIONS STATUS TO COMPLETED
    // ============================================
    const { error: sessionSuccessError } = await supabaseAdmin
      .from('game_sessions')
      .update({
        status: 'completed',
        total_score: finalScore
      })
      .eq('id', sessionId);

    if (sessionSuccessError) {
      console.warn('[Supabase] Failed to update game_sessions status to completed:', sessionSuccessError.message);
    } else {
      console.log(`[Supabase] Game session ${sessionId} marked as completed`);
    }

    console.log(`[processAudio] Finished processing for session: ${sessionId}`);

  } catch (groqError) {
    console.error(`[processAudio] Non-fatal Groq AI feedback error for session ${sessionId}:`, groqError);
    
    // Jika Groq gagal, kita tetap ubah status game_session menjadi failed, namun audio_recording tetap completed (sukses transkrip)
    await supabaseAdmin
      .from('game_sessions')
      .update({ status: 'failed' })
      .eq('id', sessionId);
  }
};
