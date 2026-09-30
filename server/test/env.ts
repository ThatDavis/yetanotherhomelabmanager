import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Load server/.env into process.env before any src module is imported
// (PrismaClient reads DATABASE_URL at construction). No-op in CI,
// where env vars come from the workflow instead of a file.
const envPath = path.resolve(import.meta.dirname, "../.env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}
