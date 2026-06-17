/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brick: {
          yellow: '#facc15',
          red: '#c1121f',
          ink: '#111827',
          panel: '#ffffff',
          line: '#d1d5db'
        }
      },
      boxShadow: {
        soft: '0 12px 30px rgba(17, 24, 39, 0.12)'
      }
    }
  },
  plugins: []
};
