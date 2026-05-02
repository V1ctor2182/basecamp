import SchedulerPanel from './finder/SchedulerPanel'

export default function Pipeline() {
  return (
    <div className="c-page">
      <h2>Pipeline</h2>
      <SchedulerPanel />
      <p className="c-page-todo">待评估岗位列表 — Stage A/B action + 批量操作。</p>
      <p className="c-page-ref">Spec: <code>06-evaluator/05-pipeline-ui</code></p>
    </div>
  )
}
