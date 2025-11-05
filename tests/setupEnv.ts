import { config as loadEnv } from 'dotenv';
import fs from 'fs';
import path from 'path';

const envPath = path.resolve(__dirname, '..', '..', '.env.test');

if (fs.existsSync(envPath)) {
	loadEnv({ path: envPath });
}

if (!process.env.REDIS_URL) {
	process.env.REDIS_URL = 'redis://localhost:6379';
}
