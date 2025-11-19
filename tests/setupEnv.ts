import { config as loadEnv } from 'dotenv';
import fs from 'fs';
import path from 'path';

const envPath = path.resolve(__dirname, '..', '.env.test');

if (fs.existsSync(envPath)) {
	loadEnv({ path: envPath });
}

// Default to redis service name in Docker Compose
// In some test environments, REDIS_URL may be set to '-redis' as a placeholder.
// This check ensures we fallback to the correct Redis URL if REDIS_URL is missing or set to the placeholder.
if (!process.env.REDIS_URL || process.env.REDIS_URL === '-redis') {
	process.env.REDIS_URL = 'redis://redis:6379';
}
