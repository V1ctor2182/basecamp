import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001'
    },
    fs: {
      allow: ['..']
    },
    watch: {
      // Watch the entire learn/ directory so any file change triggers HMR
      ignored: ['!../../**'],
    }
  },
  resolve: {
    // Ensure files outside project root resolve packages from our node_modules
    alias: {
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      'recharts': path.resolve(__dirname, 'node_modules/recharts'),
      '@nivo/core': path.resolve(__dirname, 'node_modules/@nivo/core'),
      '@nivo/bar': path.resolve(__dirname, 'node_modules/@nivo/bar'),
      '@nivo/radar': path.resolve(__dirname, 'node_modules/@nivo/radar'),
      '@nivo/line': path.resolve(__dirname, 'node_modules/@nivo/line'),
      '@nivo/pie': path.resolve(__dirname, 'node_modules/@nivo/pie'),
      '@nivo/heatmap': path.resolve(__dirname, 'node_modules/@nivo/heatmap'),
      '@nivo/network': path.resolve(__dirname, 'node_modules/@nivo/network'),
      '@nivo/tooltip': path.resolve(__dirname, 'node_modules/@nivo/tooltip'),
    }
  }
})
