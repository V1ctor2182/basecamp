import { useParams } from 'react-router-dom'

export default function Prep() {
  const { company } = useParams<{ company?: string }>()

  if (!company) {
    return (
      <div className="c-page">
        <h2>Interview Prep</h2>
        <p className="c-page-todo">选一个 Interview 状态的公司查看面试准备材料（story-bank 匹配 + deep research）。</p>
        <p className="c-page-empty">尚无 Interview 状态的公司。</p>
        <p className="c-page-ref">Spec: <code>08-human-gate-tracker/03-interview-prep</code></p>
      </div>
    )
  }

  return (
    <div className="c-page">
      <h2>Interview Prep — {company}</h2>
      <p className="c-page-todo">公司背景 + STAR+R 故事 + 行为面试题模拟 + 谈薪 prep。</p>
      <p className="c-page-ref">Spec: <code>08-human-gate-tracker/03-interview-prep</code></p>
    </div>
  )
}
