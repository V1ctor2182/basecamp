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
      '@enhance-kit': path.resolve(__dirname, 'src/enhance-kit'),
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      'recharts': path.resolve(__dirname, 'node_modules/recharts'),
      'echarts': path.resolve(__dirname, 'node_modules/echarts'),
      'echarts-for-react': path.resolve(__dirname, 'node_modules/echarts-for-react'),
    }
  }
})
