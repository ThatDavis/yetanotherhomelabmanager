import { readFileSync } from "node:fs";
import path from "node:path";

// Load server/.env into process.env before any src module is imported
// (PrismaClient reads DATABASE_URL at construction).
const envPath = path.resolve(import.meta.dirname, "../.env");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (match?.[1] && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}
