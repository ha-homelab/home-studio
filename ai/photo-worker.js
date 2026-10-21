// Receives photos only; no credentials, prompts, or project data.
import { processPhotoFile } from './photo-processing.js';
self.onmessage = async event => {
  try { self.postMessage(await processPhotoFile(event.data)); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Photo processing failed. Try a JPEG or PNG export.' }); }
};
