import { useParams } from 'react-router-dom'

export default function Reports() {
  const { id } = useParams<{ id?: string }>()

  if (!id) {
    return (
      <div className="c-page">
        <h2>Reports</h2>
        <p className="c-page-todo">评估报告列表（Block A-G markdown 渲染）。</p>
        <p className="c-page-empty">尚无评估报告。</p>
        <p className="c-page-ref">Spec: <code>08-human-gate-tracker/02-career-dashboard-views</code></p>
      </div>
    )
  }

  return (
    <div className="c-page">
      <h2>Report — {id}</h2>
      <p className="c-page-todo">单个报告 markdown 渲染 + Block A-G 目录导航 + actions (Tailor CV / Start Apply / Re-evaluate)。</p>
      <p className="c-page-ref">Spec: <code>08-human-gate-tracker/02-career-dashboard-views</code></p>
    </div>
  )
}
