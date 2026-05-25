/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        arc: {
          green:  '#10b981',
          amber:  '#f59e0b',
          red:    '#ef4444',
          bg:     '#000000',
          surface:'#09090b',
          border: '#18181b',
          muted:  '#71717a',
          sub:    '#a1a1aa',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', 'ui-monospace', 'monospace'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
