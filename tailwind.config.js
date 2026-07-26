/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {} },
  // The app uses Tailwind core utility classes plus its own CSS-variable design system (in the
  // inline <style> block inside App.jsx). Nothing custom needed here.
  plugins: [],
};
