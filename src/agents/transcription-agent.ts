/**
 * TRANSCRIPTION AGENT
 * Servicio independiente para transcribir audios con OpenAI Whisper
 * Se ejecuta como microservicio en Railway
 */

import express, { Request, Response } from 'express';
import { promises as fs } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

const app = express();
app.use(express.json());

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    whisperModel: 'whisper-1',
  },
  wati: {
    apiToken: process.env.WATI_API_TOKEN || '',
  },
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },
  port: parseInt(process.env.PORT || '3001'),
  watiAgentUrl: process.env.WATI_AGENT_URL || 'http://localhost:3000',
};

// Validate configuration
const requiredVars = ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'WATI_API_TOKEN'];
const missingVars = requiredVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`❌ Missing required env vars: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Initialize clients
const openai = new OpenAI({ apiKey: CONFIG.openai.apiKey });
const supabase = createClient(CONFIG.supabase.url, CONFIG.supabase.serviceRoleKey);

// ============================================
// ENDPOINTS
// ============================================

/**
 * Health check endpoint
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'Transcription Agent',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Main transcription endpoint
 * POST /transcribe
 * Body: { audioUrl: string, messageId: string, contactId: string }
 */
app.post('/transcribe', async (req: Request, res: Response) => {
  try {
    const { audioUrl, messageId, contactId } = req.body;

    if (!audioUrl || !messageId || !contactId) {
      return res.status(400).json({
        error: 'Missing required fields: audioUrl, messageId, contactId',
      });
    }

    console.log(`🎙️ [TRANSCRIPTION] Starting: ${messageId}`);

    // Step 1: Download audio from Wati with authentication
    console.log(`📥 [TRANSCRIPTION] Downloading audio from: ${audioUrl}`);
    const audioResponse = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${CONFIG.wati.apiToken}`,
      },
    });
    const audioBuffer = Buffer.from(audioResponse.data);
    console.log(`✅ [TRANSCRIPTION] Audio downloaded: ${audioBuffer.length} bytes`);

    // Step 2: Transcribe with Whisper
    const tempFilePath = join('/tmp', `audio-${Date.now()}.opus`);
    await fs.writeFile(tempFilePath, audioBuffer);

    const fileStream = await fs.open(tempFilePath, 'r');
    let transcript = '';

    try {
      console.log(`🎙️ [WHISPER] Sending to Whisper API...`);
      const transcription = await openai.audio.transcriptions.create({
        file: fileStream as any,
        model: CONFIG.openai.whisperModel,
        language: 'es',
        response_format: 'text',
      });
      transcript = typeof transcription === 'string' ? transcription : (transcription as any).text || '';
      console.log(`✅ [WHISPER] Transcription: "${transcript}"`);
    } finally {
      await fileStream.close();
      await fs.unlink(tempFilePath);
    }

    // Step 3: Store in Supabase
    console.log(`💾 [SUPABASE] Storing transcription...`);
    const { data, error } = await supabase.from('audio_transcriptions').insert({
      message_id: messageId,
      contact_id: contactId,
      audio_url: audioUrl,
      transcript: transcript,
      status: 'completed',
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error(`❌ [SUPABASE] Error:`, error);
      throw error;
    }

    console.log(`✅ [TRANSCRIPTION] Complete: ${messageId}`);

    // Return success with transcript
    res.json({
      success: true,
      messageId,
      contactId,
      transcript,
      storedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`❌ [TRANSCRIPTION] Error:`, error.message);
    res.status(500).json({
      error: 'Transcription failed',
      details: error.message,
    });
  }
});

/**
 * Callback endpoint (for future async processing)
 * POST /transcribe/async
 */
app.post('/transcribe/async', async (req: Request, res: Response) => {
  try {
    const { audioUrl, messageId, contactId, callbackUrl } = req.body;

    if (!audioUrl || !messageId || !contactId || !callbackUrl) {
      return res.status(400).json({
        error: 'Missing fields: audioUrl, messageId, contactId, callbackUrl',
      });
    }

    res.json({ accepted: true, messageId });

    (async () => {
      try {
        const audioResponse = await axios.get(audioUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            Authorization: `Bearer ${CONFIG.wati.apiToken}`,
          },
        });
        const audioBuffer = Buffer.from(audioResponse.data);

        const tempFilePath = join('/tmp', `audio-${Date.now()}.opus`);
        await fs.writeFile(tempFilePath, audioBuffer);
        const fileStream = await fs.open(tempFilePath, 'r');

        let transcript = '';
        try {
          const transcription = await openai.audio.transcriptions.create({
            file: fileStream as any,
            model: CONFIG.openai.whisperModel,
            language: 'es',
            response_format: 'text',
          });
          transcript = typeof transcription === 'string' ? transcription : (transcription as any).text || '';
        } finally {
          await fileStream.close();
          await fs.unlink(tempFilePath);
        }

        await supabase.from('audio_transcriptions').insert({
          message_id: messageId,
          contact_id: contactId,
          audio_url: audioUrl,
          transcript: transcript,
          status: 'completed',
          created_at: new Date().toISOString(),
        });

        await axios.post(callbackUrl, {
          messageId,
          contactId,
          transcript,
          status: 'completed',
        });

        console.log(`✅ [ASYNC] Completed: ${messageId}`);
      } catch (error: any) {
        console.error(`❌ [ASYNC] Error processing ${messageId}:`, error.message);

        await supabase.from('audio_transcriptions').insert({
          message_id: messageId,
          contact_id: contactId,
          audio_url: audioUrl,
          transcript: null,
          status: 'failed',
          error_message: error.message,
          created_at: new Date().toISOString(),
        });

        try {
          await axios.post(callbackUrl, {
            messageId,
            contactId,
            status: 'failed',
            error: error.message,
          });
        } catch {
          console.error(`❌ [ASYNC] Callback failed for ${messageId}`);
        }
      }
    })();
  } catch (error: any) {
    console.error(`❌ [ASYNC] Error:`, error.message);
    res.status(500).json({
      error: 'Async transcription failed',
      details: error.message,
    });
  }
});

// ============================================
// START SERVER
// ============================================

app.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`\n🎙️ Transcription Agent running on port ${CONFIG.port}`);
  console.log(`📍 Health: http://0.0.0.0:${CONFIG.port}/health`);
  console.log(`📍 Transcribe: POST http://0.0.0.0:${CONFIG.port}/transcribe`);
  console.log(`📍 Wati Agent: ${CONFIG.watiAgentUrl}\n`);
});

process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received - shutting down gracefully');
  process.exit(0);
});
