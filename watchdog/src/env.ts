// Load .env if present. Node >= 20.12 ships process.loadEnvFile, so no dotenv dependency.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment (e.g. docker compose env_file).
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Set it in .env (see .env.example).`);
  return value;
}
