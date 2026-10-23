// Load the repo-root .env for CLI scripts when present; CI and production set the environment directly.
try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // no .env file
}
