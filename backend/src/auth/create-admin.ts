import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AppDatabase } from '../db/database.js';
import { createAdmin } from './auth.js';

const rl = createInterface({ input, output });
const username = process.env.ADMIN_USERNAME ?? await rl.question('Admin username: ');
const password = process.env.ADMIN_PASSWORD ?? await rl.question('Admin password (14+ chars): ');
rl.close();
const db = new AppDatabase();
try { console.log(`Created ${JSON.stringify(await createAdmin(db, username, password))}`); } finally { db.close(); }
