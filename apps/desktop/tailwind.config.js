/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bar: "rgba(24, 24, 28, 0.86)",
        accent: "#38BDF8",
        indigoGlow: "#818CF8",
        highContrast: "#FACC15",
      },
      fontFamily: {
        sans: ['"Segoe UI Variable"', "Inter", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', '"Cascadia Code"', "monospace"],
      },
    },
  },
  plugins: [],
};
