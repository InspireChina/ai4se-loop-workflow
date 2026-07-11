import { migrateDatabase, paths } from '../src/infrastructure/database.js';

await migrateDatabase();
console.log(`Migrations applied to ${paths.dbPath}`);
