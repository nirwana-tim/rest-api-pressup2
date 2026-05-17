import { Router } from 'express';
import { processAudio } from '../controllers/processAudio.js';

const router = Router();

// Endpoint webhook dari rest-api-pressup 1
router.post('/process-audio', processAudio);

export default router;
