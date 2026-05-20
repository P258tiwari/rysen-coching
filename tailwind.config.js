/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./views/**/*.ejs'],
  theme: {
    extend: {
      colors: {
        bg: '#FAF8F5',
        'text-primary': '#111111',
        'text-muted': '#6B6B6B',
        gold: '#F97316',
        'dark-bg': '#0D0D0D',
        white: '#FFFFFF',
        border: '#E5E0D8'
      },
      fontFamily: {
        serif: ['Arial', 'Helvetica', 'sans-serif'],
        sans: ['Arial', 'Helvetica', 'sans-serif']
      }
    }
  },
  plugins: []
}
