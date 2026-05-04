import SchedulerPanel from './finder/SchedulerPanel'
import StageABatch from './evaluator/StageABatch'

export default function Pipeline() {
  return (
    <div className="c-page">
      <h2>Pipeline</h2>
      <SchedulerPanel />
      <StageABatch />
      <p className="c-page-todo">Stage B (Sonnet 深评) + 批量 actions ships in 06-evaluator/02-stage-b-sonnet + 05-pipeline-ui.</p>
      <p className="c-page-ref">Spec: <code>06-evaluator/05-pipeline-ui</code></p>
    </div>
  )
}
