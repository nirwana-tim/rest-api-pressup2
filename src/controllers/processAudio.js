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

export const processAudio = async (req, res) => {
  const secretKey = req.headers['x-api-secret'];
  
  if (!secretKey || secretKey !== process.env.API_SECRET_KEY) {
    console.warn(`[processAudio] Unauthorized webhook attempt: secret key mismatch.`);
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API secret key' });
  }

  const { sessionId, audio_url, duration } = req.body;

  if (!sessionId || !audio_url) {
    return res.status(400).json({ error: 'sessionId and audio_url are required' });
  }

  // Respond immediately that we have started background processing
  res.status(202).json({ message: 'Background audio processing started', sessionId });

  console.log(`[processAudio] Started processing for session: ${sessionId}`);

  try {
    // ============================================
    // STEP 1: TRANSCRIBE AUDIO WITH ASSEMBLYAI
    // ============================================
    let transcriptText = '';
    const keyCount = rotator.getKeyCount();
    let transcribed = false;

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
    // STEP 2: SAVE RAW TRANSCRIPT TO SUPABASE
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
    }

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
      
      Output harus dalam format JSON yang valid dengan struktur berikut:
      {
        "filler_words": ["eh", "hmm"],
        "filler_count": 2,
        "repeated_words": ["dan"],
        "total_words": 100,
        "overall_score": 85,
        "summary": "Ringkasan evaluasi...",
        "improvement_tips": "Saran perbaikan...",
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

      // ============================================
      // STEP 4: SAVE FEEDBACK TO SUPABASE
      // ============================================
      const feedbackData = {
        session_id: sessionId,
        filler_score: Math.max(0, 100 - (analysis.filler_count || 0) * 5),
        overall_score: finalScore,
        summary: analysis.summary || 'Tidak ada ringkasan',
        improvement_tips: analysis.improvement_tips || 'Terus berlatih.',
        total_words: analysis.total_words || transcriptText.split(' ').length,
      };

      // Upsert feedback
      const { data: feedback, error: feedbackError } = await supabaseAdmin
        .from('feedbacks')
        .upsert(feedbackData, { onConflict: 'session_id' })
        .select()
        .single();

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
        improvement_tips: 'Silakan coba berbicara lebih keras atau periksa mikrofon Anda.',
        total_words: 0
      };

      const { error: feedbackError } = await supabaseAdmin
        .from('feedbacks')
        .upsert(feedbackData, { onConflict: 'session_id' });

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

  } catch (error) {
    console.error(`[processAudio] Error processing session ${sessionId}:`, error);
    
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
  }
};
