import { GoogleGenAI } from '@google/genai';
import { supabase } from '../supabase.js';
import { log } from '../logger.js';

export async function generateMusicLyria(
  prompt: string,
  duration_s: number,
  brand?: string,
  mood?: string,
  has_build?: boolean
): Promise<string> {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'mcp-video-photo-social';

  let client;
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    client = new GoogleGenAI({ 
      vertexai: { project: projectId, location: 'us-central1' },
      credentials: { client_email: creds.client_email, private_key: creds.private_key } 
    });
  } else {
    client = new GoogleGenAI({ vertexai: { project: projectId, location: 'us-central1' } });
  }
  const modelId = duration_s <= 30 ? 'lyria-3-clip-preview' : 'lyria-3-pro-preview';
  
  log.info(`Apelăm Vertex AI ${modelId} pentru generare muzică...`);
  const interaction = await client.interactions.create({
    model: modelId,
    input: prompt,
  });

  if (!interaction.output_audio) {
    throw new Error('Vertex AI nu a returnat output_audio.');
  }

  // Base64 to ArrayBuffer
  const buffer = Buffer.from(interaction.output_audio as any, 'base64');
  const fileName = `${Date.now()}-${brand || 'audio'}.mp3`;
  
  log.info(`Uploadăm ${fileName} în Supabase audio-library...`);
  
  const { error: uploadError } = await supabase.storage
    .from('audio-library')
    .upload(fileName, buffer, {
      contentType: 'audio/mpeg',
      upsert: false
    });

  if (uploadError) {
    throw new Error(`Eroare upload Supabase: ${uploadError.message}`);
  }

  const { data: pubData } = supabase.storage
    .from('audio-library')
    .getPublicUrl(fileName);
    
  const publicUrl = pubData.publicUrl;

  log.info(`Salvăm metadatele în audio_library tabel: ${publicUrl}`);

  const { error: dbError } = await supabase.from('audio_library').insert({
    brand,
    mood,
    duration_s,
    has_build,
    url: publicUrl,
    prompt
  });

  if (dbError) {
    log.error(`Eroare la inserarea în audio_library: ${dbError.message}`);
    // Chiar dacă e eroare în DB, returnăm URL-ul piesei
  }

  return publicUrl;
}
