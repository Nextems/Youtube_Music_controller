/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        panel: "rgba(15, 18, 26, 0.72)",
        row: "rgba(255, 255, 255, 0.06)",
      },
      borderRadius: {
        card: "28px",
      },
    },
  },
  plugins: [],
};
