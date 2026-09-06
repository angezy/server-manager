import { config } from './config.js';
import { createApp, createContext } from './api/server-app.js';

if (config.NODE_ENV !== 'test' && typeof process.getuid === 'function' && process.getuid() === 0) throw new Error('Server Manager API must not run as root');
const ctx = createContext();
const app = createApp(ctx);
const server = app.listen(config.PORT, config.HOST, () => console.log(`Server Manager listening on http://${config.HOST}:${config.PORT}`));
const shutdown = (): void => { server.close(() => { ctx.db.close(); process.exit(0); }); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
