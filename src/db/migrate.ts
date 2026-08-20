import { closeDatabase, openDatabase } from "./database.js";

const databasePath = process.env.DOCS_DB_PATH?.trim() || "/data/slab-docs.db";
const database = openDatabase(databasePath);
closeDatabase(database);
console.log("Slab Docs migrations complete.");
