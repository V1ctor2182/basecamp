import SchedulerPanel from './finder/SchedulerPanel'
import StageABatch from './evaluator/StageABatch'
import StageBBatch from './evaluator/StageBBatch'

export default function Pipeline() {
  return (
    <div className="c-page">
      <h2>Pipeline</h2>
      <SchedulerPanel />
      <StageABatch />
      <StageBBatch />
      <p className="c-page-todo">More batch actions ship in 06-evaluator/05-pipeline-ui.</p>
      <p className="c-page-ref">Spec: <code>06-evaluator/05-pipeline-ui</code></p>
    </div>
  )
}
