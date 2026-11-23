export function createClient() {
  const token = process.env.API_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new Error("API_TOKEN is required");
  }
  return { ready: true };
}
