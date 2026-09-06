import { AppDatabase } from './database.js';
const db = new AppDatabase();
db.close();
console.log('Database migrations applied.');
