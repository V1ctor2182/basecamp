import BudgetBanner from './evaluator/BudgetBanner'
import SchedulerPanel from './finder/SchedulerPanel'
import StageABatch from './evaluator/StageABatch'
import StageBBatch from './evaluator/StageBBatch'
import PipelineList from './pipeline/PipelineList'
import './pipeline/pipeline-list.css'

export default function Pipeline() {
  return (
    <div className="c-page">
      <h2>Pipeline</h2>
      <BudgetBanner />
      <SchedulerPanel />
      <StageABatch />
      <StageBBatch />
      <PipelineList />
    </div>
  )
}
