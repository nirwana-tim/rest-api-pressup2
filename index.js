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

// Routes
app.get('/', (req, res) => res.json({ message: 'API 2 (Background Processor) is running 🚀' }));
app.use('/api', audioRoutes);

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Route tidak ditemukan' }));

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
