/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0E141B",
        card: "#141C24",
        accent: "#00E5FF",
        success: "#22c55e"
      }
    }
  },
  plugins: []
}
