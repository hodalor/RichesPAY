import type { Config } from "tailwindcss";
import richesPayTailwindPreset from "@richespay/ui/tailwind-preset";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
  presets: [richesPayTailwindPreset],
  plugins: []
} satisfies Config;
