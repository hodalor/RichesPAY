function readRequiredEnv(key: "VITE_API_BASE_URL" | "VITE_APP_NAME"): string {
  const value = import.meta.env[key];

  if (!value) {
    throw new Error(`${key} is required`);
  }

  return value;
}

export const env = {
  apiBaseUrl: readRequiredEnv("VITE_API_BASE_URL"),
  appName: readRequiredEnv("VITE_APP_NAME"),
  bearerToken: import.meta.env.VITE_BEARER_TOKEN ?? ""
};
