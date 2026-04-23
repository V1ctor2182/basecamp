import { Link } from 'react-router-dom'
import { ArrowLeft, Briefcase } from 'lucide-react'
import './career.css'

export default function CareerApp() {
  return (
    <div className="career">
      <header className="c-header">
        <div className="c-header-left">
          <Link to="/" className="c-back" aria-label="Back to Learn">
            <ArrowLeft size={16} />
          </Link>
          <Briefcase size={20} strokeWidth={2} />
          <h1>Career</h1>
        </div>
      </header>

      <main className="c-body">
        <div className="c-placeholder">
          <Briefcase size={48} strokeWidth={1.5} />
          <h2>Career System</h2>
          <p>AI 求职自动化 — 多简历定制、AI 评分、半自动填表、全本地数据</p>
          <p className="c-coming-soon">Coming Soon</p>
        </div>
      </main>
    </div>
  )
}
