function readRequiredEnv(
  key:
    | "VITE_API_BASE_URL"
    | "VITE_APP_NAME"
    | "VITE_SUPABASE_URL"
    | "VITE_SUPABASE_ANON_KEY"
): string {
  const value = import.meta.env[key];

  if (!value) {
    throw new Error(`${key} is required`);
  }

  return value;
}

export const env = {
  apiBaseUrl: readRequiredEnv("VITE_API_BASE_URL"),
  appName: readRequiredEnv("VITE_APP_NAME"),
  supabaseAnonKey: readRequiredEnv("VITE_SUPABASE_ANON_KEY"),
  supabaseUrl: readRequiredEnv("VITE_SUPABASE_URL")
};
