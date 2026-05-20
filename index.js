import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import audioRoutes from './src/routes/audio.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Log incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Routes
app.get('/', (req, res) => res.json({ message: 'API 2 (Background Processor) is running 🚀' }));
app.use('/api', audioRoutes);

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Route tidak ditemukan' }));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Unhandled Error: ${err.message}`, err.stack);
  res.status(500).json({ error: 'Terjadi kesalahan server internal' });
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
