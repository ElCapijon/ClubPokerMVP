/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        felt: {
          DEFAULT: '#1a6b3c',
          dark: '#0f4d2a',
          light: '#2a8f50',
        },
        poker: {
          red: '#c0392b',
          gold: '#f1c40f',
          black: '#2c3e50',
          chip: '#e74c3c',
        },
      },
      fontFamily: {
        display: ['"Playfair Display"', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      animation: {
        'card-deal': 'cardDeal 0.5s ease-out',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-chip': 'pulseChip 1.5s infinite',
      },
      keyframes: {
        cardDeal: {
          '0%': { transform: 'translateY(-100px) scale(0.5) rotate(-10deg)', opacity: '0' },
          '100%': { transform: 'translateY(0) scale(1) rotate(0deg)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        pulseChip: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(241, 196, 15, 0.4)' },
          '50%': { boxShadow: '0 0 0 15px rgba(241, 196, 15, 0)' },
        },
      },
    },
  },
  plugins: [],
};
