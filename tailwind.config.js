/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,ts,jsx,tsx}', './components/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        tw: {
          bg:       '#0d0f14',
          bg2:      '#13161d',
          bg3:      '#1a1e28',
          border:   'rgba(255,255,255,0.07)',
          border2:  'rgba(255,255,255,0.12)',
          text:     '#e8eaf0',
          text2:    '#8a91a8',
          text3:    '#555d72',
          green:    '#00d4a4',
          red:      '#ff5c7a',
          amber:    '#f5a623',
          purple:   '#a78bfa',
          blue:     '#60a5fa',
          teal:     '#2dd4bf',
          coral:    '#fb923c',
        }
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'monospace'],
      }
    }
  },
  plugins: []
}
