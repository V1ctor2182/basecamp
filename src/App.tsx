import { BrowserRouter, Routes, Route } from 'react-router-dom'
import LearnApp from './LearnApp'
import TrackerApp from './TrackerApp'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LearnApp />} />
        <Route path="/tracker" element={<TrackerApp />} />
      </Routes>
    </BrowserRouter>
  )
}
