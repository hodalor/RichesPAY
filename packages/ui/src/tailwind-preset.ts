import type { Config } from "tailwindcss";

export const richesPayTailwindPreset = {
  theme: {
    extend: {
      borderRadius: {
        card: "12px",
        input: "8px"
      },
      boxShadow: {
        soft: "0 10px 30px rgba(17, 24, 39, 0.04)",
        softer: "0 4px 16px rgba(17, 24, 39, 0.03)"
      },
      colors: {
        canvas: "rgb(var(--rp-canvas) / <alpha-value>)",
        surface: {
          DEFAULT: "rgb(var(--rp-surface) / <alpha-value>)",
          subtle: "rgb(var(--rp-surface-subtle) / <alpha-value>)"
        },
        border: {
          DEFAULT: "rgb(var(--rp-border) / <alpha-value>)",
          strong: "rgb(var(--rp-border-strong) / <alpha-value>)"
        },
        text: {
          DEFAULT: "rgb(var(--rp-text-primary) / <alpha-value>)",
          secondary: "rgb(var(--rp-text-secondary) / <alpha-value>)",
          muted: "rgb(var(--rp-text-muted) / <alpha-value>)"
        },
        brand: {
          50: "rgb(var(--rp-orange-50) / <alpha-value>)",
          100: "rgb(var(--rp-orange-100) / <alpha-value>)",
          200: "rgb(var(--rp-orange-200) / <alpha-value>)",
          300: "rgb(var(--rp-orange-300) / <alpha-value>)",
          400: "rgb(var(--rp-orange-400) / <alpha-value>)",
          500: "rgb(var(--rp-orange-500) / <alpha-value>)",
          600: "rgb(var(--rp-orange-600) / <alpha-value>)",
          700: "rgb(var(--rp-orange-700) / <alpha-value>)",
          800: "rgb(var(--rp-orange-800) / <alpha-value>)",
          900: "rgb(var(--rp-orange-900) / <alpha-value>)",
          DEFAULT: "rgb(var(--rp-orange-500) / <alpha-value>)",
          hover: "rgb(var(--rp-orange-600) / <alpha-value>)"
        },
        success: {
          DEFAULT: "rgb(var(--rp-success) / <alpha-value>)",
          soft: "rgb(var(--rp-success-soft) / <alpha-value>)"
        },
        warning: {
          DEFAULT: "rgb(var(--rp-warning) / <alpha-value>)",
          soft: "rgb(var(--rp-warning-soft) / <alpha-value>)"
        },
        danger: {
          DEFAULT: "rgb(var(--rp-danger) / <alpha-value>)",
          soft: "rgb(var(--rp-danger-soft) / <alpha-value>)"
        },
        info: {
          DEFAULT: "rgb(var(--rp-info) / <alpha-value>)",
          soft: "rgb(var(--rp-info-soft) / <alpha-value>)"
        },
        neutral: {
          DEFAULT: "rgb(var(--rp-neutral) / <alpha-value>)",
          soft: "rgb(var(--rp-neutral-soft) / <alpha-value>)"
        }
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"]
      }
    }
  }
} satisfies Partial<Config>;

export default richesPayTailwindPreset;
